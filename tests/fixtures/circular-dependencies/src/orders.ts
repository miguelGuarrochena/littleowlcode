import { currentUser } from './users';

export function orders() {
  return currentUser();
}
