import { query } from '../lib/db/client';

export interface Order {
  id: string;
}

export const listOrders = (): Order[] => {
  return query<Order>('select * from orders');
};
