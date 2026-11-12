import type { CSSProperties } from "react";

export type StudioIconName =
  | "cube"
  | "upload"
  | "download"
  | "edit"
  | "share"
  | "arrow"
  | "back"
  | "refresh"
  | "image"
  | "close"
  | "game"
  | "eraser"
  | "picker"
  | "undo"
  | "redo";
const paths: Record<StudioIconName, string> = {
  cube: "m12 3 9 5v9l-9 5-9-5V8l9-5Zm0 10 9-5M12 13 3 8m9 5v9M7.5 5.5l9 5",
  upload: "M12 16V3m-5 5 5-5 5 5M4 15v5a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-5",
  download: "M12 3v13m-5-5 5 5 5-5M4 16v4a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-4",
  edit: "m15 4 5 5M3 21l5-1L21 7a2 2 0 0 0-5-5L3 15v6Z",
  share:
    "m8 11 8-5m-8 7 8 5M8 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Zm14-8a3 3 0 1 1-6 0 3 3 0 0 1 6 0Zm0 16a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z",
  arrow: "m9 5 7 7-7 7",
  back: "m14 5-7 7 7 7M7 12h14",
  refresh: "M20 8a8 8 0 0 0-14-3L3 8m0-5v5h5m-4 8a8 8 0 0 0 14 3l3-3m0 5v-5h-5",
  image:
    "M4 3h16a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Zm-1 13 5-5 4 4 3-3 6 6M8 7h.01",
  close: "m6 6 12 12M6 18 18 6",
  game: "M7 8h10a4 4 0 0 1 4 3l1 7c.3 3-3 4-5 1l-1-1H8l-1 1c-2 3-5 2-5-1l1-7a4 4 0 0 1 4-3Zm-1 5h4m-2-2v4m8-3h.01M18 14h.01",
  eraser: "m3 14 10-11 8 8-9 10H9l-6-7Zm4-4 8 8m-3 3h9",
  picker: "m14 3 7 7m-8-4 5 5L7 22H2v-5L13 6Z",
  undo: "M4 9h10a7 7 0 0 1 0 14M4 9l6-6M4 9l6 6",
  redo: "M20 9H10a7 7 0 0 0 0 14m10-14-6-6m6 6-6 6",
};
export function StudioIcon({
  name,
  size = 20,
  style,
}: {
  name: StudioIconName;
  size?: number;
  style?: CSSProperties;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      style={style}
    >
      <path d={paths[name]} />
    </svg>
  );
}
