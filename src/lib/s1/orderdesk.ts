/* The "order desk" benchmark environment, after the demo task in
   SystemOneHarness's README (Apache-2.0; design only). Deterministic: the same
   actions always produce the same states, so a run can be replayed and a
   decider's mistakes counted exactly.

   Policy the goal describes: cancel an order flagged for fraud, ship a gift
   with the fastest carrier, ship everything else with the cheapest. */

import type { ActionSpec, Decider, EnvResult, Environment, Observation, ParamValue } from "./types";
import { ACTION_Q, GOAL_Q, paramQ } from "./compile";

export interface Order { id: string; item: string; fraud: boolean; gift: boolean }

export const ORDER_DESK_GOAL = "Process every pending order: cancel orders flagged for fraud, ship gift orders with the fastest carrier, ship all other orders with the cheapest carrier. Then finish.";

export const DEFAULT_ORDERS: Order[] = [
  { id: "A1", item: "Desk lamp", fraud: false, gift: true },
  { id: "B2", item: "USB-C hub", fraud: true, gift: false },
  { id: "C3", item: "Notebook set", fraud: false, gift: false },
];

export const ORDER_ACTIONS: ActionSpec[] = [
  { name: "cancel_fraud", description: "Cancel an order that is flagged for fraud", risk: "destructive", params: [{ name: "order", kind: "candidates", description: "Which pending order to cancel" }] },
  { name: "ship_fastest_gift", description: "Ship a gift order with the fastest carrier", risk: "write", params: [{ name: "order", kind: "candidates", description: "Which pending order to ship fastest" }] },
  { name: "ship_cheapest", description: "Ship an ordinary order with the cheapest carrier", risk: "write", params: [{ name: "order", kind: "candidates", description: "Which pending order to ship cheapest" }] },
  { name: "done", description: "Finish: every order has been processed", risk: "finish" },
];

const correctAction = (o: Order) => (o.fraud ? "cancel_fraud" : o.gift ? "ship_fastest_gift" : "ship_cheapest");

export function createOrderDesk(orders: Order[] = DEFAULT_ORDERS): Environment & { mistakes: () => string[]; processed: () => Record<string, string> } {
  const done: Record<string, string> = {};
  const mistakes: string[] = [];
  const pending = () => orders.filter((o) => !done[o.id]);
  const observe = (): Observation => ({
    text: pending().length ? `${pending().length} order(s) pending.` : "No orders pending.",
    fields: { pending: pending().map((o) => ({ id: o.id, item: o.item, fraud_flag: o.fraud, gift: o.gift })), processed: { ...done } },
    candidates: { order: Object.fromEntries(pending().map((o) => [o.id, `${o.item}${o.fraud ? ", FLAGGED FOR FRAUD" : ""}${o.gift ? ", gift" : ""}`])) },
  });
  const execute = (action: string, params: Record<string, ParamValue>): EnvResult => {
    if (action === "done") {
      const left = pending().length;
      const success = left === 0 && mistakes.length === 0;
      return { ok: true, terminal: true, success, text: success ? "All orders processed correctly." : `Finished with ${left} pending and ${mistakes.length} mistake(s).` };
    }
    const order = orders.find((o) => o.id === params.order && !done[o.id]);
    if (!order) return { ok: false, text: `No pending order ${String(params.order)}.` };
    done[order.id] = action;
    if (action !== correctAction(order)) mistakes.push(`${order.id}: ${action}, expected ${correctAction(order)}`);
    return { ok: true, text: `${order.id} ${action.replace(/_/g, " ")}.` };
  };
  return { id: "orderdesk", name: "Order desk (benchmark)", actions: ORDER_ACTIONS, observe, execute, mistakes: () => [...mistakes], processed: () => ({ ...done }) };
}

/** A scripted decider that knows the policy, so the harness can be shown
 *  working offline. Its probabilities are fixed numbers, not a model's; the
 *  UI labels it "scripted". `confidence` lets a demo push it under a gate. */
export function scriptedOrderDecider(orders: Order[] = DEFAULT_ORDERS, confidence = 0.92): Decider {
  return {
    kind: "scripted",
    label: "Scripted policy (offline demo)",
    decide: async ({ questions }) => {
      const offered = questions[ACTION_Q].type === "choice" ? Object.keys(questions[ACTION_Q].criteria) : [];
      const q = questions[paramQ("cancel_fraud", "order")] ?? questions[paramQ("ship_cheapest", "order")];
      const pendingIds = q && q.type === "choice" ? Object.keys(q.criteria) : [];
      const next = orders.find((o) => pendingIds.includes(o.id));
      const action = next ? correctAction(next) : "done";
      const spread = (keys: string[], pick: string) => Object.fromEntries(keys.map((k) => [k, k === pick ? confidence : (1 - confidence) / Math.max(1, keys.length - 1)]));
      const answers: Record<string, unknown> = { [ACTION_Q]: { choice: action, probabilities: spread(offered, action) }, [GOAL_Q]: { noul: next ? 0.05 : confidence } };
      for (const a of ["cancel_fraud", "ship_fastest_gift", "ship_cheapest"]) {
        if (questions[paramQ(a, "order")] && next) answers[paramQ(a, "order")] = { choice: next.id, probabilities: spread(pendingIds, next.id) };
      }
      return { raw: { answers }, costUsd: 0 };
    },
  };
}
