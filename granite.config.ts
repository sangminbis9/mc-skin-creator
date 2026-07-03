import { defineConfig } from "@apps-in-toss/web-framework/config";

export default defineConfig({
  appName: "mc-skin-creator",
  brand: {
    displayName: "마크 스킨 만들기",
    primaryColor: "#5BB544",
    // TODO: 출시 전에 앱인토스 콘솔에 등록한 앱 아이콘 이미지 주소로 바꿔주세요.
    icon: "",
  },
  web: {
    host: "localhost",
    port: 5173,
    commands: {
      dev: "vite dev",
      build: "vite build",
    },
  },
  permissions: [
    {
      name: "photos",
      access: "read",
    },
  ],
  outdir: "dist",
});
