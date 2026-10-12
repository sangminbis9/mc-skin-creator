import { DurableObject } from "cloudflare:workers";
import { budgetStatus, newBudgetState, reserveBudget, settleBudget, type BudgetState } from "./freeBudget";

/** One coordination atom per project's daily allowance. No inference runs in
 * this object. SQLite-backed transactions serialize even cross-isolate calls. */
export class NeuronBudget extends DurableObject {
  async status() {
    const day = new Date().toISOString().slice(0, 10);
    return budgetStatus(await this.ctx.storage.get<BudgetState>(`day:${day}`) ?? newBudgetState(day));
  }
  async reserve(id: string) {
    const day = new Date().toISOString().slice(0, 10);
    const accepted = await this.ctx.storage.transaction(async txn => {
      const state = await txn.get<BudgetState>(`day:${day}`) ?? newBudgetState(day);
      if (!reserveBudget(state, id)) return false;
      await txn.put(`day:${day}`, state); return true;
    });
    if (accepted && await this.ctx.storage.getAlarm() === null) await this.ctx.storage.setAlarm(Date.now() + 48 * 60 * 60 * 1000);
    return { accepted, day };
  }
  async settle(day: string, id: string, charged: number) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error("Invalid budget day");
    await this.ctx.storage.transaction(async txn => {
      const state = await txn.get<BudgetState>(`day:${day}`);
      if (!state) return;
      settleBudget(state, id, charged); await txn.put(`day:${day}`, state);
    });
  }
  async alarm() {
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const states = await this.ctx.storage.list<BudgetState>({ prefix: "day:" });
    const expired = [...states.keys()].filter(key => key.slice(4) < cutoff);
    if (expired.length) await this.ctx.storage.delete(expired);
    if (states.size > expired.length) await this.ctx.storage.setAlarm(Date.now() + 24 * 60 * 60 * 1000);
  }
}
