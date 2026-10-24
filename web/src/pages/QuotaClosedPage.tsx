/**
 * Today's generation limit is reached 안내 화면.
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
        Today's generation limit is reached
      </h1>

      <PixelPanel tone="dirt" style={{ textAlign: "center" }}>
        <p style={{ margin: 0, fontSize: 14, lineHeight: 1.9 }}>
          The shared free AI generation budget has been used.
          <br />
          The budget resets at the time shown below.
          <br />
          You can still explore the sample skin, edit and export.
        </p>
      </PixelPanel>

      {quota && (
        <p className="px-caption" style={{ textAlign: "center", margin: 0 }}>
          Next reset: {formatResetTime(quota.resetAtIso)}
        </p>
      )}

      <PixelButton variant="stone" onClick={onBack}>
        Back to the studio
      </PixelButton>
    </div>
  );
}
