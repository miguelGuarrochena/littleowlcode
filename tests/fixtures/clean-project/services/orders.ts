import { query } from '../lib/db/client';

export interface Order {
  id: string;
}

export function listOrders(): Order[] {
  return query<Order>('select * from orders');
}
