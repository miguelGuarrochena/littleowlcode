import { auth } from './auth';

export function currentUser() {
  return auth();
}
