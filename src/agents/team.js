import { ProductOwnerAgent } from './productOwner.js';
import { DeveloperAgent } from './developer.js';
import { QaAgent } from './qa.js';

/**
 * The Milestone 1 team: PO, Dev and QA. Every member is a scripted agent.
 * The human user is not an agent: they request and guide the product.
 */
export function createTeam() {
  const members = [new ProductOwnerAgent(), new DeveloperAgent(), new QaAgent()];
  return new Map(members.map((agent) => [agent.id, agent]));
}
