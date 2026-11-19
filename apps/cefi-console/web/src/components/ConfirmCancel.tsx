import { Button, Modal } from "./ui.tsx";

export function ConfirmCancel({
  title,
  body,
  pending,
  onConfirm,
  onClose,
  confirmLabel = "Send cancels",
}: {
  title: string;
  body: string;
  pending: boolean;
  onConfirm: () => void;
  onClose: () => void;
  confirmLabel?: string;
}) {
  return (
    <Modal
      title={title}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Keep orders</Button>
          <Button tone="danger" disabled={pending} onClick={onConfirm} autoFocus>
            {pending ? "Sending…" : confirmLabel}
          </Button>
        </>
      }
    >
      <p className="text-xs leading-relaxed text-muted">{body}</p>
    </Modal>
  );
}
