import { useState } from 'react';
import { REJECT_REASON_LABELS, REJECT_REASONS, type RejectReason } from '../api';

interface Props {
  busy: boolean;
  onConfirm: (reasons: RejectReason[], comment: string) => void;
  onCancel: () => void;
}

/**
 * Refus d'une proposition : un ou plusieurs motifs, commentaire facultatif — obligatoire avec
 * « Autre ». Le bouton reste désactivé tant que la saisie n'est pas valide.
 */
export function RejectDialog({ busy, onConfirm, onCancel }: Props) {
  const [reasons, setReasons] = useState<RejectReason[]>([]);
  const [comment, setComment] = useState('');
  const needsComment = reasons.includes('autre');
  const valid = reasons.length > 0 && (!needsComment || comment.trim() !== '');

  const toggle = (r: RejectReason) =>
    setReasons((cur) => (cur.includes(r) ? cur.filter((x) => x !== r) : [...cur, r]));

  return (
    <div role="dialog" aria-label="Motifs du refus" className="reject-dialog">
      <fieldset>
        <legend>Pourquoi refuser ce moment ? (un ou plusieurs motifs)</legend>
        {REJECT_REASONS.map((r) => (
          <label key={r} className="reason">
            <input type="checkbox" checked={reasons.includes(r)} onChange={() => toggle(r)} />{' '}
            {REJECT_REASON_LABELS[r]}
          </label>
        ))}
      </fieldset>
      <label>
        Commentaire {needsComment ? '(obligatoire avec « Autre »)' : '(facultatif)'}
        <textarea
          value={comment}
          maxLength={2000}
          rows={3}
          onChange={(e) => setComment(e.target.value)}
        />
      </label>
      <div className="actions">
        <button
          type="button"
          disabled={!valid || busy}
          onClick={() => onConfirm(reasons, comment.trim())}
        >
          Confirmer le refus
        </button>{' '}
        <button type="button" onClick={onCancel} disabled={busy}>
          Annuler
        </button>
      </div>
    </div>
  );
}
