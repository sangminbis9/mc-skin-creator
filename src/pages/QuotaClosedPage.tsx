/**
 * 오늘 생성 마감 안내 화면.
 */

import { PixelButton } from "../components/pixel/PixelButton";
import { PixelPanel } from "../components/pixel/PixelPanel";
import type { QuotaStatus } from "../lib/skinFeatures";
import { formatResetTime } from "../lib/quotaText";

interface QuotaClosedPageProps {
  quota: QuotaStatus | null;
  onBack: () => void;
}

export function QuotaClosedPage({ quota, onBack }: QuotaClosedPageProps) {
  return (
    <div className="px-screen px-screen--center">
      <div style={{ textAlign: "center", fontSize: 44 }} aria-hidden="true">
        🌙
      </div>
      <h1 className="px-title" style={{ textAlign: "center" }}>
        오늘 생성 마감
      </h1>

      <PixelPanel tone="dirt" style={{ textAlign: "center" }}>
        <p style={{ margin: 0, fontSize: 14, lineHeight: 1.9 }}>
          오늘의 AI 스킨 생성 수량이 모두 마감됐어요.
          <br />
          무료 생성 한도는 매일 오전 9시에 다시 열려요.
          <br />
          내일 다시 방문해 나만의 마크 스킨을 만들어보세요.
        </p>
      </PixelPanel>

      {quota && (
        <p className="px-caption" style={{ textAlign: "center", margin: 0 }}>
          다음 오픈: {formatResetTime(quota.resetAtIso)}
        </p>
      )}

      <PixelButton variant="stone" onClick={onBack}>
        처음으로 돌아가기
      </PixelButton>
    </div>
  );
}
