import { afterEach, describe, expect, it, vi } from "vitest";
import { runSkinCritique } from "../src/skinCritique";
import type { Env } from "../src/types";
import { makeAnalysis, makeSyntheticAtlas } from "./helpers";

afterEach(() => vi.unstubAllGlobals());

describe("Gemini rendered-skin critique", () => {
  it("calibrates likeness review to achievable Minecraft layer geometry", async () => {
    const fetchMock = vi.fn(
      async (_input: string | URL | Request, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as {
          contents: Array<{ parts: Array<{ text?: string }> }>;
        };
        const prompt = body.contents[0].parts.at(-1)?.text ?? "";
        expect(prompt).toContain("standard cubic Minecraft player");
        expect(prompt).toContain("accidental outlier");
        expect(prompt).toContain(
          "transparent/non-transparent outer-layer steps",
        );
        expect(prompt).toContain("8x12 torso");
        expect(prompt).toContain("Machine-measured atlas facts");
        expect(prompt).toContain("head outer layer:");
        expect(prompt).toContain("opaque RGB colors");
        const labels = body.contents[0].parts
          .map((part) => part.text)
          .filter(Boolean);
        expect(labels[0]).toContain("Source photo 0");
        expect(labels[1]).toContain("NOT a source photo");
        return Response.json({
          candidates: [
            {
              content: {
                parts: [
                  {
                    text: JSON.stringify({
                      identityScore: 90,
                      faceHairScore: 88,
                      outfitScore: 84,
                      consistencyScore: 91,
                      layerScore: 76,
                      defects: [],
                    }),
                  },
                ],
              },
            },
          ],
        });
      },
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await runSkinCritique(
      { GEMINI_API_KEY: "test" } as Env,
      makeAnalysis(),
      ["data:image/png;base64,AQID"],
      "data:image/png;base64,BAUG",
      undefined,
      makeSyntheticAtlas(),
    );

    expect(result.ok).toBe(true);
  });

  it("approves a high-scoring atlas with no critical defects", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          candidates: [
            {
              content: {
                parts: [
                  {
                    text: JSON.stringify({
                      identityScore: 90,
                      faceHairScore: 88,
                      outfitScore: 84,
                      consistencyScore: 91,
                      layerScore: 76,
                      defects: [],
                    }),
                  },
                ],
              },
            },
          ],
        }),
      ),
    );
    const result = await runSkinCritique(
      { GEMINI_API_KEY: "test" } as Env,
      makeAnalysis(),
      ["data:image/png;base64,AQID"],
      "data:image/png;base64,BAUG",
    );
    expect(result.ok && result.approved).toBe(true);
  });

  it("uses all five same-person photos before the rendered montage", async () => {
    const fetchMock = vi.fn(
      async (_input: string | URL | Request, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as {
          contents: Array<{
            parts: Array<{ text?: string; inlineData?: { data: string } }>;
          }>;
        };
        const parts = body.contents[0].parts;
        const labels = parts
          .filter((part) => part.text?.endsWith(":"))
          .map((part) => part.text);
        const images = parts
          .filter((part) => part.inlineData)
          .map((part) => part.inlineData?.data);
        expect(labels).toHaveLength(6);
        expect(labels.slice(0, 5)).toEqual([
          expect.stringContaining("Source photo 0"),
          expect.stringContaining("Source photo 1"),
          expect.stringContaining("Source photo 2"),
          expect.stringContaining("Source photo 3"),
          expect.stringContaining("Source photo 4"),
        ]);
        expect(labels[5]).toContain("NOT a source photo");
        expect(images).toEqual(["AAA0", "AAA1", "AAA2", "AAA3", "AAA4", "BBBB"]);
        return Response.json({
          candidates: [
            {
              content: {
                parts: [
                  {
                    text: JSON.stringify({
                      identityScore: 90,
                      faceHairScore: 88,
                      outfitScore: 84,
                      consistencyScore: 91,
                      layerScore: 76,
                      defects: [],
                    }),
                  },
                ],
              },
            },
          ],
        });
      },
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await runSkinCritique(
      { GEMINI_API_KEY: "test" } as Env,
      makeAnalysis(),
      Array.from(
        { length: 5 },
        (_, index) => `data:image/png;base64,AAA${index}`,
      ),
      "data:image/png;base64,BBBB",
    );

    expect(result.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("returns a bounded region-specific correction for major likeness loss", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          candidates: [
            {
              content: {
                parts: [
                  {
                    text: JSON.stringify({
                      identityScore: 62,
                      faceHairScore: 58,
                      outfitScore: 82,
                      consistencyScore: 80,
                      layerScore: 72,
                      defects: [
                        {
                          category: "face_hair",
                          severity: "major",
                          feature: "side-swept fringe",
                          evidence: "rendered fringe is centered",
                          targetRegions: ["head.front", "head.overlay"],
                          correction: "move the fringe opening left",
                        },
                      ],
                    }),
                  },
                ],
              },
            },
          ],
        }),
      ),
    );
    const result = await runSkinCritique(
      { GEMINI_API_KEY: "test" } as Env,
      makeAnalysis(),
      ["data:image/png;base64,AQID"],
      "data:image/png;base64,BAUG",
    );
    expect(result.ok && result.approved).toBe(false);
    expect(result.ok && result.correctionPrompt).toContain(
      "head.front+head.overlay",
    );
  });

  it("falls back to a separate critique model when the primary quota is exhausted", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      if (String(input).includes("primary-model")) {
        return Response.json(
          {
            error: {
              code: 429,
              status: "RESOURCE_EXHAUSTED",
              message: "primary quota exhausted; retry in 25s",
            },
          },
          { status: 429 },
        );
      }
      return Response.json({
        candidates: [
          {
            content: {
              parts: [
                {
                  text: JSON.stringify({
                    identityScore: 90,
                    faceHairScore: 88,
                    outfitScore: 84,
                    consistencyScore: 91,
                    layerScore: 76,
                    defects: [],
                  }),
                },
              ],
            },
          },
        ],
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await runSkinCritique(
      {
        GEMINI_API_KEY: "test",
        VISION_MODEL: "primary-model",
        VISION_FALLBACK_MODEL: "fallback-model",
      } as Env,
      makeAnalysis(),
      ["data:image/png;base64,AQID"],
      "data:image/png;base64,BAUG",
    );

    expect(result.ok && result.approved).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain("fallback-model");
  });
});
