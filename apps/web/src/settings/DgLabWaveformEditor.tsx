import { useEffect, useState } from "react";

import { parseWaveformText, serializeWaveform } from "../dglab/dglabWaveforms.ts";
import type { DgLabConfig } from "../dglab/dglabTypes.ts";

interface DgLabWaveformEditorProps {
  readonly config: DgLabConfig;
  readonly onChange: (config: DgLabConfig) => void;
}

export function DgLabWaveformEditor({ config, onChange }: DgLabWaveformEditorProps): React.JSX.Element {
  const [text, setText] = useState(() => serializeWaveform(config.customWaveform));
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setText(serializeWaveform(config.customWaveform));
  }, [config.customWaveform]);

  const apply = (value: string): void => {
    setText(value);
    const frames = parseWaveformText(value);
    if (frames === null) {
      setError("格式无效：至少需要 4 帧，每帧为 频率,强度（频率 10-240，强度 0-100）。");
      return;
    }
    setError(null);
    onChange({ ...config, waveform: "custom", customWaveform: frames });
  };

  const importFile = (event: React.ChangeEvent<HTMLInputElement>): void => {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    if (file === undefined) return;
    void file.text().then(apply).catch(() => setError("无法读取波形文件。"));
  };

  return <div className="dglab-waveform-editor">
    <div className="dglab-waveform-editor__header"><span>自定义波形帧</span><span className="dglab-waveform-editor__count">{config.customWaveform.length} 帧 · {config.customWaveform.length / 10}s 循环</span></div>
    <textarea aria-label="自定义波形帧" onChange={(event) => apply(event.currentTarget.value)} placeholder={'12,0\n12,30\n20,80\n20,0'} spellCheck={false} value={text} />
    <div className="dglab-waveform-editor__actions"><label className="dglab-file-button"><input accept=".json,.txt,.hex,application/json,text/plain" onChange={importFile} type="file" />导入波形文件</label><span className="dglab-field__hint">支持 JSON 帧数组、HEX 帧列表或每行“频率,强度”。</span></div>
    {error !== null && <p className="dglab-waveform-editor__error" role="alert">{error}</p>}
  </div>;
}
