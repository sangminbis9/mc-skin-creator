/**
 * 이미지 생성 provider 추상화.
 * 현재 구현은 Cloudflare Workers AI의 FLUX.2 [klein] 4B (멀티 레퍼런스 이미지 편집).
 * 모델 교체/외부 API 전환 시 이 인터페이스 뒤에서만 바꾼다.
 */

import type { PhotoAnalysis } from "./analysis";
import { base64ToBytes, sniffImageSize } from "./png";
import { buildFrontViewPrompt, buildSkinPrompt } from "./skinPrompt";
import type { Env } from "./types";
import { UV_GUIDE_PNG_B64 } from "./assets/uvGuide";

/**
 * front_view: 정면 전신 캐릭터 1장 생성 (skinPack이 atlas로 조립) — 기본 전략
 * direct_atlas: 모델이 atlas를 직접 그리게 시도 (현재 FLUX는 배치를 자주 어긴다)
 */
export type GenerationStrategy = "front_view" | "direct_atlas";

export interface SkinGenerationRequest {
  analysis: PhotoAnalysis;
  photoDataUrl: string;
  seed: number;
  mode: GenerationStrategy;
}

export type SkinGenerationResult =
  | { ok: true; imageBytes: Uint8Array; inputTiles: number; outputTiles: number }
  /** retryable: seed를 바꿔 재시도할 가치가 있는 실패 (moderation flag, 일시 오류 등) */
  | { ok: false; error: string; retryable: boolean };

export interface SkinGenerationProvider {
  generate(request: SkinGenerationRequest): Promise<SkinGenerationResult>;
}

const FLUX_MODEL = "@cf/black-forest-labs/flux-2-klein-4b";
/** FLUX 입력 이미지 제약: 512x512보다 작아야 한다 */
const MAX_INPUT_EDGE = 511;
const MIN_INPUT_EDGE = 64;
/** direct_atlas 출력 크기 (64의 배수, 후처리에서 8x8 셀 축소) */
const OUTPUT_SIZE = 512;
/** front_view 출력 크기: 정면+뒷면 두 뷰가 나란히 (512x512 타일 2개 비용) */
const FRONT_VIEW_WIDTH = 1024;
const FRONT_VIEW_HEIGHT = 512;

/**
 * 스타일 참고 스킨(448x448 PNG base64) 조회 순서:
 * 1) env.STYLE_REF_B64 — 로컬 개발 전용(.dev.vars, gitignore 대상).
 *    사용 권리가 확인되지 않은 참고 이미지는 저장소/원격에 올리지 않는다.
 * 2) KV "asset:style-ref-448" — 운영용. 프로젝트가 소유한 참고 스킨을
 *    확보한 뒤에만 이 키에 업로드한다.
 * 둘 다 없으면 스타일 참고 없이(2-이미지 모드) 동작한다.
 */
export const STYLE_REF_KV_KEY = "asset:style-ref-448";

function dataUrlToBytes(
  dataUrl: string,
): { bytes: Uint8Array; mime: string } | null {
  const match = /^data:(image\/[a-z+.-]+);base64,(.+)$/i.exec(dataUrl);
  if (!match) {
    return null;
  }
  try {
    return { bytes: base64ToBytes(match[2]), mime: match[1] };
  } catch {
    return null;
  }
}

export class FluxKleinProvider implements SkinGenerationProvider {
  private styleRefPromise: Promise<Uint8Array | null> | null = null;

  constructor(private readonly env: Env) {}

  private loadStyleRef(): Promise<Uint8Array | null> {
    this.styleRefPromise ??= (async () => {
      try {
        const local = this.env.STYLE_REF_B64;
        if (local) {
          return base64ToBytes(local.trim());
        }
        const b64 = await this.env.MCSKIN_KV.get(STYLE_REF_KV_KEY);
        return b64 ? base64ToBytes(b64) : null;
      } catch {
        return null;
      }
    })();
    return this.styleRefPromise;
  }

  async generate(request: SkinGenerationRequest): Promise<SkinGenerationResult> {
    const photo = dataUrlToBytes(request.photoDataUrl);
    if (!photo) {
      return { ok: false, error: "사진 data URL을 해석하지 못함", retryable: false };
    }
    const size = sniffImageSize(photo.bytes);
    if (!size) {
      return { ok: false, error: "사진 크기를 판별하지 못함 (PNG/JPEG 아님)", retryable: false };
    }
    if (size.width > MAX_INPUT_EDGE || size.height > MAX_INPUT_EDGE) {
      // 구버전 클라이언트(448 축소 이전)의 큰 사진 — 이미지 생성은 건너뛴다
      return {
        ok: false,
        error: `사진이 FLUX 입력 제한 초과 (${size.width}x${size.height})`,
        retryable: false,
      };
    }
    if (size.width < MIN_INPUT_EDGE || size.height < MIN_INPUT_EDGE) {
      return {
        ok: false,
        error: `사진이 너무 작음 (${size.width}x${size.height})`,
        retryable: false,
      };
    }

    let prompt: string;
    let images: Uint8Array[];
    if (request.mode === "front_view") {
      // 정면 뷰 모드: 사용자 사진만 참조 (배치는 서버 코드가 책임진다)
      prompt = buildFrontViewPrompt(request.analysis);
      images = [photo.bytes];
    } else {
      const styleRef = await this.loadStyleRef();
      const hasStyleRef = styleRef !== null;
      prompt = buildSkinPrompt(request.analysis, { hasStyleRef });
      images = hasStyleRef
        ? [styleRef, photo.bytes, base64ToBytes(UV_GUIDE_PNG_B64)]
        : [photo.bytes, base64ToBytes(UV_GUIDE_PNG_B64)];
    }

    const width = request.mode === "front_view" ? FRONT_VIEW_WIDTH : OUTPUT_SIZE;
    const height = request.mode === "front_view" ? FRONT_VIEW_HEIGHT : OUTPUT_SIZE;
    const form = new FormData();
    images.forEach((bytes, index) => {
      const mime = bytes === photo.bytes ? photo.mime : "image/png";
      form.append(`input_image_${index}`, new Blob([bytes], { type: mime }));
    });
    form.append("prompt", prompt);
    form.append("width", String(width));
    form.append("height", String(height));
    form.append("seed", String(request.seed));

    // FormData 직렬화 + multipart boundary가 포함된 Content-Type 확보
    const formResponse = new Response(form);
    const contentType = formResponse.headers.get("content-type");
    if (!formResponse.body || !contentType) {
      return { ok: false, error: "multipart 직렬화 실패", retryable: false };
    }

    let image: unknown;
    try {
      const result = (await this.env.AI.run(FLUX_MODEL as never, {
        multipart: {
          body: formResponse.body,
          contentType,
        },
      } as never)) as { image?: unknown };
      image = result?.image;
    } catch (error) {
      return {
        ok: false,
        error: `FLUX 호출 실패: ${error instanceof Error ? error.message : String(error)}`,
        // moderation flag 등은 seed/프롬프트가 달라지면 통과할 수 있다
        retryable: true,
      };
    }
    if (typeof image !== "string" || image.length === 0) {
      return { ok: false, error: "FLUX 응답에 image가 없음", retryable: true };
    }
    try {
      return {
        ok: true,
        imageBytes: base64ToBytes(image),
        inputTiles: images.length,
        outputTiles: Math.ceil((width * height) / (512 * 512)),
      };
    } catch {
      return { ok: false, error: "FLUX image base64 디코드 실패", retryable: true };
    }
  }
}
