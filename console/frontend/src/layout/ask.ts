// SPDX-License-Identifier: MIT
import { createContext, useContext } from "react";

/**
 * Ask Vertra, for any page to offer: its model (undefined while the console
 * is asked, null when no model is set), and opening its panel. Outside the
 * app's shell (a test rendering one page) there's none.
 */
export interface Ask {
  model: string | null | undefined;
  open: () => void;
}

export const AskContext = createContext<Ask>({ model: null, open: () => {} });

export const useAsk = () => useContext(AskContext);
