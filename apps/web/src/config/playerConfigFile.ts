import {
  normalizePlayerConfig,
  type PlayerConfig
} from "./v3/index.ts";

export function downloadPlayerConfig(config: PlayerConfig): void {
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(config, null, 2)], {
      type: "application/json;charset=utf-8"
    })
  );
  const link = document.createElement("a");
  link.download = `tetr-d-config-${new Date().toISOString().slice(0, 10)}.json`;
  link.href = url;
  link.click();
  URL.revokeObjectURL(url);
}

export async function readPlayerConfigFile(file: File): Promise<PlayerConfig> {
  if (file.size > 64 * 1_024) {
    throw new RangeError("配置文件不能大于 64 KiB。");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(await file.text());
  } catch {
    throw new TypeError("配置文件不是有效的 JSON。");
  }
  const config = normalizePlayerConfig(parsed);
  if (config === null) {
    throw new TypeError("配置版本或字段无效。");
  }
  return config;
}
