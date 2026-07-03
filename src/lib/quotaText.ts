/** quota 리셋 시각 표시용 문자열 (KST) */
export function formatResetTime(resetAtIso: string): string {
  const date = new Date(resetAtIso);
  if (Number.isNaN(date.getTime())) {
    return "매일 오전 9시 (한국 시간)";
  }
  const formatter = new Intl.DateTimeFormat("ko-KR", {
    timeZone: "Asia/Seoul",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
  return formatter.format(date);
}
