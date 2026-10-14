import { defineConfig } from "@apps-in-toss/web-framework/config";

export default defineConfig({
  appName: "mc-skin-creator",
  brand: {
    primaryColor: "#b6ed78",
  },
  permissions: [
    {
      name: "photos",
      access: "read",
    },
  ],
  webBundleDir: "dist",
});
