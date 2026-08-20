import { query } from '../lib/db/client';

export function Orders() {
  const rows = query('select * from orders');
  return <div>{rows.length}</div>;
}
