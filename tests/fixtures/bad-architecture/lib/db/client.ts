import { Orders } from '../../components/Orders';

export const query = (sql: string): unknown[] => {
  return [sql, Orders];
};
