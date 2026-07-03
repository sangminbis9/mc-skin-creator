/**
 * 공개 운영 대시보드 (#/admin) — "서비스 현황판".
 * 조회 전용: 어떤 조정/제어 기능도 없다.
 */

import { useEffect, useState } from "react";
import { PixelBadge } from "../components/pixel/PixelBadge";
import { PixelPanel } from "../components/pixel/PixelPanel";
import { PixelProgress } from "../components/pixel/PixelProgress";
import { fetchDailyStats, type DailyStats } from "../lib/cloudflareAI";
import { formatResetTime } from "../lib/quotaText";

const REFRESH_INTERVAL_MS = 30_000;

export function AdminDashboard() {
  const [stats, setStats] = useState<DailyStats | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const load = () =>
      fetchDailyStats().then((data) => {
        setStats(data);
        setFailed(data === null);
      });
    load();
    const timer = setInterval(load, REFRESH_INTERVAL_MS);
    return () => clearInterval(timer);
  }, []);

  const successRate =
    stats && stats.attempts > 0
      ? Math.round((stats.successes / stats.attempts) * 100)
      : null;

  return (
    <div className="px-screen">
      <h1 className="px-title">📊 서비스 현황판</h1>
      <p className="px-subtitle">
        오늘의 운영 현황이에요. 30초마다 자동으로 새로고침돼요.
      </p>

      {failed && (
        <PixelPanel tone="dirt">
          <p style={{ margin: 0, fontSize: 13 }}>
            현황 서버에 연결하지 못했어요. 잠시 후 다시 확인해주세요.
          </p>
        </PixelPanel>
      )}

      {stats && (
        <>
          <PixelPanel>
            <div className="px-row" style={{ justifyContent: "space-between" }}>
              <span style={{ fontWeight: 700, fontSize: 14 }}>AI 생성 한도</span>
              {stats.quota.level === "closed" ? (
                <PixelBadge tone="red">오늘 마감</PixelBadge>
              ) : stats.quota.level === "almost" ? (
                <PixelBadge tone="gold">거의 마감</PixelBadge>
              ) : (
                <PixelBadge tone="green">생성 가능</PixelBadge>
              )}
            </div>
            <div style={{ margin: "12px 0 6px" }}>
              <PixelProgress
                value={stats.quota.usedRatio * 100}
                tone={
                  stats.quota.level === "closed"
                    ? "danger"
                    : stats.quota.level === "almost"
                      ? "gold"
                      : "grass"
                }
              />
            </div>
            <p className="px-caption" style={{ margin: 0 }}>
              사용률 {Math.round(stats.quota.usedRatio * 100)}% · 예상 남은 생성{" "}
              {stats.quota.remainingGenerations}회
              <br />
              다음 리셋: {formatResetTime(stats.quota.resetAtIso)} (매일 오전 9시)
            </p>
          </PixelPanel>

          <div
            style={{
              display: "grid",
              gridTemplateColumns: "1fr 1fr",
              gap: 10,
            }}
          >
            <StatCard label="생성 시도" value={stats.attempts} icon="🧪" />
            <StatCard label="생성 성공" value={stats.successes} icon="✅" />
            <StatCard label="생성 실패" value={stats.failures} icon="❌" />
            <StatCard
              label="성공률"
              value={successRate === null ? "-" : `${successRate}%`}
              icon="📈"
            />
            <StatCard label="광고 노출" value={stats.adImpressions} icon="📺" />
            <StatCard label="공유 클릭" value={stats.shareClicks} icon="📤" />
            <StatCard label="공유 링크 생성" value={stats.shareLinks} icon="🔗" />
            <StatCard label="다운로드" value={stats.downloads} icon="⬇️" />
          </div>

          <p className="px-caption" style={{ textAlign: "center" }}>
            기준일: {stats.date} (KST) · 이 화면은 조회 전용이에요
          </p>
        </>
      )}

      <a href="#/" className="px-btn px-btn--stone" style={{ textDecoration: "none" }}>
        앱으로 돌아가기
      </a>
    </div>
  );
}

function StatCard({
  label,
  value,
  icon,
}: {
  label: string;
  value: number | string;
  icon: string;
}) {
  return (
    <PixelPanel style={{ padding: 12, textAlign: "center" }}>
      <div style={{ fontSize: 20 }} aria-hidden="true">
        {icon}
      </div>
      <div style={{ fontSize: 20, fontWeight: 700, marginTop: 4 }}>{value}</div>
      <div className="px-caption">{label}</div>
    </PixelPanel>
  );
}
