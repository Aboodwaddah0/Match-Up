import { Router } from 'express';
import { authenticate, requireVerifiedEmail } from '../../middleware/authenticate';
import { validate } from '../../middleware/validate';
import * as bookings from './bookings.controller';
import {
  bookingIdParams,
  createBookingSchema,
  externalBookingSchema,
  myBookingsSchema,
  reasonSchema,
  venueBookingsSchema,
  venueIdParams,
} from './bookings.schemas';

// ───────── /api/v1/bookings (players / organizers, plus venue staff answering requests) ─────────
export const bookingsRouter = Router();
bookingsRouter.use(authenticate);

bookingsRouter.post('/', requireVerifiedEmail, validate({ body: createBookingSchema }), bookings.create);
bookingsRouter.post('/external', requireVerifiedEmail, validate({ body: externalBookingSchema }), bookings.createExternal);
bookingsRouter.get('/mine', validate({ query: myBookingsSchema }), bookings.mine);
bookingsRouter.get('/:bookingId', validate({ params: bookingIdParams }), bookings.get);
bookingsRouter.post('/:bookingId/cancel', validate({ params: bookingIdParams, body: reasonSchema, optionalBody: true }), bookings.cancel);

// venue staff answer requests (permission is checked in the service, per venue)
bookingsRouter.post('/:bookingId/confirm', validate({ params: bookingIdParams }), bookings.confirm);
bookingsRouter.post('/:bookingId/reject', validate({ params: bookingIdParams, body: reasonSchema, optionalBody: true }), bookings.reject);

// ───────── /api/v1/venues/:venueId/bookings (venue staff inbox) ─────────
export const venueBookingsRouter = Router({ mergeParams: true });
venueBookingsRouter.use(authenticate);
venueBookingsRouter.get('/', validate({ params: venueIdParams, query: venueBookingsSchema }), bookings.venueInbox);
