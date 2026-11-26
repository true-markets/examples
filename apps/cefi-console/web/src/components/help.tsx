import { createContext, useContext, type ReactNode } from "react";

// The explanations under the Quoter screen's parameters and panels are for learning the quoter;
// once you know it, the Help switch in the Quoter bar hides them. The choice is kept per browser.
// Tooltips stay. Confirmation dialogs keep their text: it says what you're agreeing to.
export const ShowHelp = createContext(true);

export const useShowHelp = () => useContext(ShowHelp);

// Shows its children only while Help is on.
export function Help({ children }: { children: ReactNode }) {
  return useShowHelp() ? <>{children}</> : null;
}
