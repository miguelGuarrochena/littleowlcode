import { query } from '../lib/db/client';

export function listOrders() {
  return query('select * from orders');
}
