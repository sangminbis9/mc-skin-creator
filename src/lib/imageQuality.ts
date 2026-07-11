/**
 * 업로드 사진 품질 체크 (클라이언트 휴리스틱).
 * 해상도 / 밝기 / 선명도(라플라시안 분산)를 빠르게 검사해 PASS/WARN/FAIL을 낸다.
 * 얼굴 존재 여부 등 정밀 판단은 서버의 AI가 생성 단계에서 수행한다.
 */

export type QualityVerdict = "pass" | "warn" | "fail";

export interface QualityCheckResult {
  verdict: QualityVerdict;
  messages: string[];
  width: number;
  height: number;
}

const ANALYZE_SIZE = 256;

export async function checkImageQuality(
  dataUrl: string,
): Promise<QualityCheckResult> {
  const image = await loadImage(dataUrl);
  const { width, height } = image;
  const messages: string[] = [];
  let verdict: QualityVerdict = "pass";

  const raise = (level: QualityVerdict, message: string) => {
    messages.push(message);
    if (level === "fail" || (level === "warn" && verdict === "pass")) {
      verdict = level === "fail" ? "fail" : verdict === "fail" ? "fail" : "warn";
    }
  };

  // 해상도 — 입력은 448 상한으로 축소된 업로드본이므로 그 기준으로 판정한다
  // (세로 사진은 긴 변 448 기준 짧은 변이 ~336까지 정상)
  const minSide = Math.min(width, height);
  if (minSide < 200) {
    raise("fail", "사진이 너무 작아요. 더 큰 사진을 올려주세요.");
  } else if (minSide < 260) {
    raise("warn", "사진이 조금 작아요. 얼굴이 잘 보이면 괜찮아요.");
  }

  // 축소해서 밝기/선명도 분석
  const scale = ANALYZE_SIZE / Math.max(width, height);
  const w = Math.max(1, Math.round(width * scale));
  const h = Math.max(1, Math.round(height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) {
    return { verdict, messages, width, height };
  }
  ctx.drawImage(image, 0, 0, w, h);
  const data = ctx.getImageData(0, 0, w, h).data;

  // 그레이스케일
  const gray = new Float32Array(w * h);
  let sum = 0;
  for (let i = 0; i < w * h; i++) {
    const v =
      (0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2]) /
      255;
    gray[i] = v;
    sum += v;
  }
  const brightness = sum / (w * h);

  if (brightness < 0.12) {
    raise("warn", "사진이 너무 어두워요. 밝은 곳에서 찍은 사진이 좋아요.");
  } else if (brightness > 0.95) {
    raise("warn", "사진이 너무 밝아요. 얼굴이 잘 보이는 사진이 좋아요.");
  }

  // 라플라시안 분산 (선명도)
  let lapSum = 0;
  let lapSqSum = 0;
  let count = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const lap =
        gray[i - w] + gray[i + w] + gray[i - 1] + gray[i + 1] - 4 * gray[i];
      lapSum += lap;
      lapSqSum += lap * lap;
      count++;
    }
  }
  const mean = lapSum / count;
  const variance = (lapSqSum / count - mean * mean) * 255 * 255;

  if (variance < 8) {
    raise("fail", "사진이 너무 흐려요. 선명한 사진을 올려주세요.");
  } else if (variance < 30) {
    raise("warn", "사진이 조금 흐릿해요. 결과가 아쉬울 수 있어요.");
  }

  if (verdict === "pass") {
    messages.push("좋아요! 이 사진으로 스킨을 만들 수 있어요.");
  }

  return { verdict, messages, width, height };
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("이미지를 불러오지 못했어요"));
    image.src = src;
  });
}

/**
 * 업로드 전 리사이즈/압축: 서버로 원본 대신 축소본만 보낸다.
 * 448 = 서버의 FLUX 이미지 생성 입력 제한(512x512 미만)에 맞춘 값.
 * 비율을 유지한 채 긴 변을 448 이하로 줄인다 (crop 없음).
 */
export async function resizeForUpload(
  source: string | File,
  maxSide = 448,
): Promise<string> {
  const dataUrl =
    typeof source === "string" ? source : await fileToDataUrl(source);
  const image = await loadImage(dataUrl);
  const scale = Math.min(1, maxSide / Math.max(image.width, image.height));
  const w = Math.max(1, Math.round(image.width * scale));
  const h = Math.max(1, Math.round(image.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    return dataUrl;
  }
  ctx.drawImage(image, 0, 0, w, h);
  return canvas.toDataURL("image/jpeg", 0.85);
}

export interface PreparedPhotoUpload {
  /** Higher-resolution input reserved for multimodal feature analysis. */
  analysisDataUrl: string;
  /** FLUX-compatible input kept below the image model's 512px limit. */
  generationDataUrl: string;
}

export async function preparePhotoForUpload(
  source: string | File,
): Promise<PreparedPhotoUpload> {
  const dataUrl =
    typeof source === "string" ? source : await fileToDataUrl(source);
  const image = await loadImage(dataUrl);
  const render = (maxSide: number): string => {
    const scale = Math.min(1, maxSide / Math.max(image.width, image.height));
    const width = Math.max(1, Math.round(image.width * scale));
    const height = Math.max(1, Math.round(image.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) return dataUrl;
    context.drawImage(image, 0, 0, width, height);
    return canvas.toDataURL("image/jpeg", 0.85);
  };
  return {
    analysisDataUrl: render(896),
    generationDataUrl: render(448),
  };
}

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(new Error("파일을 읽지 못했어요"));
    reader.readAsDataURL(file);
  });
}
