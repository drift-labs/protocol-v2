import { IUser } from '../user/types';

export interface UserEvents {
	userUpdate: (payload: IUser) => void;
	update: void;
	error: (e: Error) => void;
}
