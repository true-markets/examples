import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Check } from "lucide-react";
import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router";
import { api } from "../api.ts";
import { shortAddress } from "../format.ts";
import type { SetupResult } from "../types.ts";
import { Button, CloseButton, DetailRows, useEscape } from "./ui.tsx";

export function AddHousehold({ onClose }: { onClose: () => void }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [missing, setMissing] = useState(false);
  const add = useMutation({
    mutationFn: (body: { name: string }) => api<SetupResult>("/api/households", { method: "POST", body }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["households"] }),
  });

  useEscape(onClose);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!name.trim()) {
      setMissing(true);
      return;
    }
    add.mutate({ name: name.trim() });
  }

  const result = add.data;

  return (
    <div className="fixed inset-0 z-20 box-border flex items-start justify-center bg-[rgba(12,15,20,.36)] px-4 py-24">
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="add-household-title"
        className="box-border flex w-full max-w-[480px] flex-col rounded-[20px] bg-white shadow-[0_24px_64px_rgba(12,15,20,.22)]"
      >
        <div className="flex items-center justify-between gap-3 border-b border-hairline px-6 py-[18px]">
          <h2 id="add-household-title" className="m-0 text-[17px] font-semibold tracking-[-0.01em]">
            Add a client
          </h2>
          <CloseButton onClick={onClose} />
        </div>

        {!result && (
          <form onSubmit={submit} className="m-0 flex flex-col gap-5 p-6">
            <label className="flex flex-col gap-2 text-sm font-medium text-label">
              Client name
              <input
                autoFocus
                type="text"
                maxLength={60}
                placeholder="For example, Ōtomo and Hana Fujiwara"
                value={name}
                onChange={(e) => {
                  setName(e.target.value);
                  setMissing(false);
                }}
                className="box-border h-11 rounded-xl border border-control bg-white px-3.5 text-base text-ink"
              />
            </label>
            <p className="m-0 text-sm leading-[1.55] text-label">
              Kumi opens a client wallet and a trading wallet in this client's name and holds both signing keys.
              Assets move into the trading wallet only for a trade and go back as soon as it's done.
            </p>
            {missing && (
              <p role="alert" className="m-0 text-sm text-error">
                Enter the household's name.
              </p>
            )}
            {add.error && (
              <p role="alert" className="m-0 text-sm text-error">
                {add.error.message}
              </p>
            )}
            <div className="flex justify-end gap-2">
              <Button variant="secondary" onClick={onClose}>
                Cancel
              </Button>
              <button type="submit" disabled={add.isPending} className="inline-flex h-11 cursor-pointer items-center rounded-[22px] border-0 bg-ink px-[18px] text-sm font-medium text-white disabled:cursor-wait disabled:opacity-60">
                {add.isPending ? "Adding…" : "Add client"}
              </button>
            </div>
          </form>
        )}

        {result && (
          <div role="status" className="flex flex-col gap-[18px] p-6">
            <div className="flex items-center gap-2.5">
              {result.ready && (
                <span aria-hidden className="flex size-7 items-center justify-center rounded-full bg-ink text-white">
                  <Check className="size-[15px]" strokeWidth={2.4} />
                </span>
              )}
              <span className="text-base font-medium">
                {result.ready
                  ? `${result.household.name} added. Trading wallet ready.`
                  : "Trading wallet not created yet. Use Finish setup to try again."}
              </span>
            </div>
            <div className="border-t border-hairline">
              <DetailRows
                rows={[
                  { k: "Client wallet", v: shortAddress(result.household.safekeeping_address), mono: true },
                  {
                    k: "Trading wallet",
                    v: result.household.trading_address ? shortAddress(result.household.trading_address) : "Not created yet",
                    mono: result.household.trading_address !== null,
                  },
                ]}
              />
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="secondary" onClick={onClose}>
                Done
              </Button>
              <Button onClick={() => navigate(`/households/${result.household.id}`)}>Open client</Button>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
