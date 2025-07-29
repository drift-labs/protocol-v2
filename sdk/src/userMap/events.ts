import { User } from '../user';

export interface UserEvents {
	userUpdate: (payload: User) => void;
	update: void;
	error: (e: Error) => void;
}
