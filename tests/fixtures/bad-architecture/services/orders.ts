import { query } from '../lib/db/client';

export const listOrders = () => {
  return query('select * from orders');
};
