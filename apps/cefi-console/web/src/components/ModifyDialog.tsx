import { useState } from "react";
import type { OrderRow } from "../../../shared/api.ts";
import { useModifyOrder } from "../api.ts";
import { qty as fmtQty } from "../format.ts";
import { Button, Field, Modal, SideText, inputClass } from "./ui.tsx";

// PATCH /v1/cefi/orders takes the new total quantity (not the remaining) and the new price.
// A modify loses the order's place in the queue.
export function ModifyDialog({ order, onClose }: { order: OrderRow; onClose: () => void }) {
  const [qty, setQty] = useState(order.qty);
  const [price, setPrice] = useState(order.price ?? "");
  const modify = useModifyOrder();
  const valid = Number(qty) > Number(order.executedQty) && Number(price) > 0;

  return (
    <Modal
      title={
        <span>
          Modify <SideText side={order.side} /> {order.symbol}
        </span>
      }
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Close</Button>
          <Button tone="primary" disabled={!valid || modify.isPending} onClick={() => modify.mutate({ orderId: order.orderId, qty, price }, { onSuccess: onClose })}>
            {modify.isPending ? "Sending…" : "Send modify"}
          </Button>
        </>
      }
    >
      <div className="grid grid-cols-2 gap-3">
        <Field label="New price">
          <input className={inputClass} value={price} onChange={(e) => setPrice(e.target.value)} inputMode="decimal" autoFocus />
        </Field>
        <Field label="New total qty">
          <input className={inputClass} value={qty} onChange={(e) => setQty(e.target.value)} inputMode="decimal" />
        </Field>
      </div>
      <p className="text-[11px] leading-relaxed text-faint">
        Filled so far: <span className="num">{fmtQty(order.executedQty)}</span>. The new quantity is the order's total and must be more than what has filled. A
        modified order goes to the back of the queue at its price.
      </p>
    </Modal>
  );
}
