/**
 * 공유: 3D 미리보기 이미지 + 토스 공유 링크.
 * 토스 앱 안에서는 getTossShareLink + share, 브라우저에서는 Web Share API 폴백.
 */

import { getTossShareLink, share } from "@apps-in-toss/web-framework";
import { trackEvent } from "./cloudflareAI";

// TODO: 앱인토스 콘솔에서 발급된 앱 스킴/공유 설정에 맞게 확인해주세요.
const APP_SCHEME = "intoss://mc-skin-creator";
const SHARE_MESSAGE =
  "사진으로 나만의 마인크래프트 스킨을 만들었어요! 너도 만들어봐 🟩";
const OG_IMAGE_URL =
  "https://static.toss.im/icons/png/4x/icon-share-dots-mono.png";

/** 토스 공유 링크 생성 + 공유 시트 열기 */
export async function shareTossLink(): Promise<boolean> {
  try {
    const link = await getTossShareLink(APP_SCHEME, OG_IMAGE_URL);
    trackEvent("share_link");
    await share({ message: `${SHARE_MESSAGE}\n${link}` });
    trackEvent("share_click");
    return true;
  } catch {
    // 토스 앱 밖 — Web Share API 폴백
  }
  try {
    if (navigator.share) {
      await navigator.share({ text: SHARE_MESSAGE, url: location.href });
      trackEvent("share_click");
      return true;
    }
  } catch {
    // 사용자가 취소했거나 미지원
  }
  return false;
}

/** 3D 미리보기 이미지를 파일로 공유 (지원 환경에서만) */
export async function sharePreviewImage(dataUrl: string): Promise<boolean> {
  try {
    const blob = await (await fetch(dataUrl)).blob();
    const file = new File([blob], "mc-skin-preview.png", { type: "image/png" });
    if (navigator.canShare?.({ files: [file] })) {
      await navigator.share({ files: [file], text: SHARE_MESSAGE });
      trackEvent("share_click");
      return true;
    }
  } catch {
    // 미지원/취소 — 링크 공유로 폴백
  }
  return shareTossLink();
}
