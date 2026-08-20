import { Orders } from '../../components/Orders';

export function query(sql: string): unknown[] {
  return [sql, Orders];
}
