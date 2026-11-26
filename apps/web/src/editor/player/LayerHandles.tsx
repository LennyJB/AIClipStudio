/**
 * Poignées de cadrage sur l'aperçu (docs/plan-etape-7.md §4, `setLayer`) : cadre de chaque calque
 * de la disposition libre (ou de la surcharge du segment sous la tête de lecture), déplaçable et
 * redimensionnable. Un glissement = un geste, envoyé au relâchement.
 */
import { useRef, useState } from 'react';
import type { ClipProjectV2, Layer } from '@acs/timeline';
import { clampRect, setLayers, type Gesture } from '../actions';
import { editLayersTarget } from '../inspector/Inspector';
import type { Selection } from '../ui-store';

interface Props {
  doc: ClipProjectV2;
  playheadMs: number;
  editable: boolean;
  selection: Selection | null;
  onSelect: (s: Selection) => void;
  onGesture: (g: Gesture) => void;
}

type Mode = 'move' | 'resize';

export function LayerHandles({ doc, playheadMs, editable, selection, onSelect, onGesture }: Props) {
  const box = useRef<HTMLDivElement | null>(null);
  const [drag, setDrag] = useState<{
    id: string;
    mode: Mode;
    x0: number;
    y0: number;
    dx: number;
    dy: number;
    /** Taille de l'aperçu au début du geste (pixels). */
    width: number;
    height: number;
  } | null>(null);
  const target = editLayersTarget(doc, playheadMs);
  if (!target) return null;

  const framed = (l: Layer) => {
    if (!drag || drag.id !== l.id) return l.frame;
    const fx = drag.dx / drag.width;
    const fy = drag.dy / drag.height;
    return clampRect(
      drag.mode === 'move'
        ? { ...l.frame, x: l.frame.x + fx, y: l.frame.y + fy }
        : { ...l.frame, w: l.frame.w + fx, h: l.frame.h + fy },
    );
  };

  const up = () => {
    if (!drag) return;
    const layer = target.layers.find((l) => l.id === drag.id);
    setDrag(null);
    if (!layer || (Math.abs(drag.dx) < 2 && Math.abs(drag.dy) < 2)) return;
    const frame = framed(layer);
    onGesture(
      setLayers(
        doc,
        target.layers.map((l) => (l.id === layer.id ? { ...l, frame } : l)),
        target.segmentId,
        drag.mode === 'move' ? 'calque déplacé' : 'calque redimensionné',
      ),
    );
  };

  return (
    <div
      ref={box}
      className="layer-handles"
      onPointerMove={(e) =>
        drag && setDrag({ ...drag, dx: e.clientX - drag.x0, dy: e.clientY - drag.y0 })
      }
      onPointerUp={up}
      onPointerCancel={up}
    >
      {target.layers.map((l) => {
        const f = framed(l);
        const sel = selection?.kind === 'layer' && selection.id === l.id;
        const begin = (mode: Mode) => (e: React.PointerEvent) => {
          onSelect({ kind: 'layer', id: l.id });
          if (!editable) return;
          e.stopPropagation();
          (e.target as Element).setPointerCapture?.(e.pointerId);
          const r = box.current?.getBoundingClientRect();
          setDrag({
            id: l.id,
            mode,
            x0: e.clientX,
            y0: e.clientY,
            dx: 0,
            dy: 0,
            width: Math.max(1, r?.width ?? 1),
            height: Math.max(1, r?.height ?? 1),
          });
        };
        return (
          <div
            key={l.id}
            className={`layer-frame${sel ? ' selected' : ''}`}
            data-testid={`layer-${l.id}`}
            aria-label={`Calque ${l.role === 'facecam' ? 'facecam' : 'jeu'}`}
            style={{
              left: `${f.x * 100}%`,
              top: `${f.y * 100}%`,
              width: `${f.w * 100}%`,
              height: `${f.h * 100}%`,
            }}
            onPointerDown={begin('move')}
          >
            <span className="layer-tag">{l.role === 'facecam' ? 'facecam' : 'jeu'}</span>
            {editable && (
              <span
                className="layer-resize"
                onPointerDown={begin('resize')}
                aria-label="Redimensionner"
              />
            )}
          </div>
        );
      })}
    </div>
  );
}
