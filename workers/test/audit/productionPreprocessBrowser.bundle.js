"use strict";
(() => {
  // src/lib/imageQuality.ts
  function loadImage(src) {
    return new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error("\uC774\uBBF8\uC9C0\uB97C \uBD88\uB7EC\uC624\uC9C0 \uBABB\uD588\uC5B4\uC694"));
      image.src = src;
    });
  }
  async function preparePhotoForUpload(source) {
    const dataUrl = typeof source === "string" ? source : await fileToDataUrl(source);
    const image = await loadImage(dataUrl);
    const render = (maxSide) => {
      const scale = Math.min(1, maxSide / Math.max(image.width, image.height));
      const width = Math.max(1, Math.round(image.width * scale));
      const height = Math.max(1, Math.round(image.height * scale));
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext("2d");
      if (!context) throw new Error("\uC0AC\uC9C4\uC744 \uC555\uCD95\uD558\uC9C0 \uBABB\uD588\uC5B4\uC694. \uB2E4\uB978 \uBE0C\uB77C\uC6B0\uC800\uC5D0\uC11C \uB2E4\uC2DC \uC2DC\uB3C4\uD574 \uC8FC\uC138\uC694.");
      context.drawImage(image, 0, 0, width, height);
      return boundedJpeg(canvas);
    };
    return {
      analysisDataUrl: render(896),
      generationDataUrl: render(448)
    };
  }
  function boundedJpeg(canvas) {
    for (const quality of [0.85, 0.75, 0.6]) {
      const dataUrl = canvas.toDataURL("image/jpeg", quality);
      if (dataUrl.startsWith("data:image/jpeg;base64,") && dataUrl.length <= 15e5) return dataUrl;
    }
    throw new Error("\uC0AC\uC9C4 \uD30C\uC77C\uC774 \uB108\uBB34 \uCEE4\uC694. \uB354 \uC791\uC740 \uC0AC\uC9C4\uC744 \uC120\uD0DD\uD574 \uC8FC\uC138\uC694.");
  }
  function fileToDataUrl(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(new Error("\uD30C\uC77C\uC744 \uC77D\uC9C0 \uBABB\uD588\uC5B4\uC694"));
      reader.readAsDataURL(file);
    });
  }

  // workers/test/audit/productionPreprocessBrowser.ts
  var status = document.getElementById("status");
  var update = (message) => {
    if (status) status.textContent = message;
  };
  async function run() {
    const response = await fetch("/source.jpg", { cache: "no-store" });
    if (!response.ok) throw new Error(`local_source_http_${response.status}`);
    const source = new File([await response.blob()], "canonical-original.jpg", { type: "image/jpeg" });
    const prepared = await preparePhotoForUpload(source);
    const result = await fetch("/result", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(prepared)
    });
    if (!result.ok) throw new Error(`local_result_http_${result.status}`);
    update("PRODUCTION_PREPROCESSING_COMPLETE");
  }
  void run().catch((error) => update(`FAILED: ${error instanceof Error ? error.message : "unknown"}`));
})();
