import { ProductOwnerAgent } from './productOwner.js';
import { DeveloperAgent } from './developer.js';
import { QaAgent } from './qa.js';

/**
 * The team: PO, Developer and QA. Every member is a scripted agent in this
 * milestone. The human user is not an agent: they request and guide the
 * product.
 */
export function createTeam({ po = new ProductOwnerAgent(), dev = new DeveloperAgent(), qa = new QaAgent() } = {}) {
  return new Map([po, dev, qa].map((agent) => [agent.id, agent]));
}
