import { listOrders } from '../services/orders';

export default function Page() {
  const orders = listOrders();
  return <ul>{orders.map((order) => <li key={order.id}>{order.id}</li>)}</ul>;
}
