import { currentUser } from './users';

export const orders = () => {
  return currentUser();
};
