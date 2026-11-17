import { Router } from 'express';
import * as cities from './cities.controller';

export const citiesRouter = Router();

// Public reference data: no authentication.
citiesRouter.get('/', cities.list);
