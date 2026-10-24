import { useT } from '../../../app/i18n.js';
import { ViewerSelect } from '../viewer-select.js';

export function IconPicker({
  frames,
  selected,
  onSelect,
}: {
  frames: { url: string; width?: number; height?: number; bpp?: number }[];
  selected: number;
  onSelect: (index: number) => void;
}) {
  const t = useT();
  const image = frames[selected];
  if (!image) return null;
  return (
    <ViewerSelect
      className="ve-icon-picker"
      label={t('viewer.iconImage')}
      value={String(selected)}
      onChange={(value) => onSelect(Number(value))}
      triggerContent={
        <>
          <img src={image.url} alt="" draggable={false} />
          <span>
            {image.width} × {image.height}
            <small>{image.bpp} bit</small>
          </span>
        </>
      }
      options={frames.map((frame, index) => ({
        value: String(index),
        label: `${frame.width} × ${frame.height} ${frame.bpp} bit`,
        content: (
          <>
            <img src={frame.url} alt="" draggable={false} />
            <span>
              {frame.width} × {frame.height}
            </span>
            <small>{frame.bpp} bit</small>
          </>
        ),
      }))}
    />
  );
}
