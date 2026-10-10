const parameters = {
  type: "object",
  additionalProperties: false,
  required: ["prompt"],
  properties: {
    prompt: { type: "string", minLength: 1, maxLength: 8000 },
    model: { type: "string", maxLength: 120 },
    size: { type: "string", maxLength: 64 },
    quality: { type: "string", maxLength: 64 },
    useReferenceImages: { type: "boolean" },
    retryOf: { type: "string", maxLength: 128 },
    resumeJobId: { type: "string", maxLength: 128 },
  },
};
export default function (pi) {
  let currentPromptImages = [];
  pi.on("before_agent_start", (event) => {
    currentPromptImages = Array.isArray(event.images)
      ? event.images.filter((image) =>
        image?.type === "image" &&
        ["image/png", "image/jpeg", "image/webp"].includes(image.mimeType)
      ).map((image) => ({ data: image.data, mimeType: image.mimeType }))
      : [];
  });
  pi.on("agent_settled", () => {
    currentPromptImages = [];
  });
  pi.registerTool({
    name: "generate_image",
    label: "生成图片",
    description:
      "Generate a new image or edit the latest conversation images through the managed Jonwork image service. Set useReferenceImages for edits. Never claim success without returned managed assets.",
    promptSnippet:
      "For image generation or editing, call generate_image. Use reference images for edits and include the returned managed image marker unchanged.",
    parameters,
    async execute(_id, params, signal, onUpdate, ctx) {
      const endpoint = process.env.JONWORK_PI_IMAGE_ENDPOINT,
        key = process.env.JONWORK_PI_IMAGE_KEY;
      if (!endpoint || !key) throw Error("JONWORK_MANAGED_ENDPOINT_REQUIRED");
      const url = new URL(endpoint);
      if (
        url.protocol !== "http:" || url.hostname !== "127.0.0.1" ||
        url.pathname !== "/internal/image/v1/generate" || url.search
      ) throw Error("JONWORK_MANAGED_ENDPOINT_REQUIRED");
      const images = params.useReferenceImages === true
        ? [...currentPromptImages]
        : [];
      if (params.useReferenceImages === true) {
        for (
          const entry of images.length
            ? []
            : [...ctx.sessionManager.getBranch()].reverse()
        ) {
          if (
            entry.type !== "message" || entry.message.role !== "user" ||
            !Array.isArray(entry.message.content)
          ) continue;
          for (const block of entry.message.content) {
            if (
              block.type === "image" &&
              ["image/png", "image/jpeg", "image/webp"].includes(block.mimeType)
            ) images.push({ data: block.data, mimeType: block.mimeType });
          }
          if (images.length) break;
        }
      }
      onUpdate?.({
        content: [{ type: "text", text: "图片生成中…" }],
        details: { status: "running" },
      });
      const response = await fetch(url, {
        method: "POST",
        signal,
        redirect: "error",
        headers: {
          authorization: `Bearer ${key}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          ...params,
          ...(images.length ? { inputImages: images } : {}),
        }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok || !body.asset) {
        throw Error(
          typeof body.error === "string" && /^[A-Z_]{1,64}$/.test(body.error)
            ? body.error
            : "IMAGE_REQUEST_FAILED",
        );
      }
      const marker = "```jonwork-image-assets\n" +
        JSON.stringify({ items: [body.asset] }) + "\n```";
      return {
        content: [{ type: "text", text: `图片生成成功。\n${marker}` }],
        details: { status: "succeeded", assets: [body.asset] },
      };
    },
  });
}
