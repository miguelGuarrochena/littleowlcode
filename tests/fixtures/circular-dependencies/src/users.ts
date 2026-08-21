import { auth } from './auth';

export const currentUser = () => {
  return auth();
};
