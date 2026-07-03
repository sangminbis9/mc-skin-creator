/**
 * 생성 중 화면 전용 광고 패널.
 * 토스 앱 안에서는 전면 광고를 로드해 1회 노출하고,
 * 지원되지 않는 환경(브라우저/샌드박스 미지원)에서는 안내 패널만 보여준다.
 *
 * 광고는 이 화면에서만 사용한다 — 결과/편집/다운로드 화면에는 넣지 않는다.
 */

import {
  loadFullScreenAd,
  showFullScreenAd,
} from "@apps-in-toss/web-framework";
import { useEffect, useRef, useState } from "react";
import { trackEvent } from "../lib/cloudflareAI";
import { PixelPanel } from "./pixel/PixelPanel";

// TODO: 출시 전에 앱인토스 콘솔에서 발급한 광고그룹 ID로 교체해주세요.
const AD_GROUP_ID = "ait-ad-test-interstitial-id";

export function AdLoadingPanel() {
  const [supported, setSupported] = useState(false);
  const shownRef = useRef(false);
  const cleanupRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    let isSupported = false;
    try {
      isSupported = loadFullScreenAd.isSupported();
    } catch {
      isSupported = false;
    }
    setSupported(isSupported);
    if (!isSupported) {
      return;
    }

    try {
      cleanupRef.current = loadFullScreenAd({
        options: { adGroupId: AD_GROUP_ID },
        onEvent: (event) => {
          if (event.type === "loaded" && !shownRef.current) {
            shownRef.current = true;
            try {
              showFullScreenAd({
                options: { adGroupId: AD_GROUP_ID },
                onEvent: () => {},
                onError: () => {},
              });
              trackEvent("ad_impression");
            } catch {
              // 표시 실패는 무시 — 생성은 계속 진행
            }
          }
        },
        onError: () => {},
      });
    } catch {
      // 로드 실패는 무시
    }

    return () => {
      try {
        cleanupRef.current?.();
      } catch {
        // cleanup 실패 무시
      }
    };
  }, []);

  return (
    <PixelPanel tone="sky" style={{ textAlign: "center", padding: 20 }}>
      <p className="px-caption" style={{ margin: 0 }}>
        AD
      </p>
      <p style={{ margin: "8px 0 0", fontSize: 14, lineHeight: 1.6 }}>
        {supported
          ? "스킨을 만드는 동안 광고가 표시될 수 있어요"
          : "스킨을 만드는 동안 잠시만 기다려주세요"}
      </p>
    </PixelPanel>
  );
}
