import { Router } from 'express';
import { authenticate, requireVerifiedEmail } from '../../middleware/authenticate';
import { venueIdParams } from '../venues/venues.schemas';
import { bookingIdParams, createBookingSchema, externalBookingSchema, myBookingsSchema, reasonSchema, venueBookingsSchema } from './bookings.schemas';
import * as bookings from './bookings.service';

const actor = (req: { auth?: { userId: string; role: 'USER' | 'ADMIN' } }) => ({ userId: req.auth!.userId, role: req.auth!.role });

// ───────── /api/v1/bookings (players / organizers) ─────────
export const bookingsRouter = Router();
bookingsRouter.use(authenticate);

bookingsRouter.post('/', requireVerifiedEmail, async (req, res) => {
  res.status(201).json(await bookings.createBooking(actor(req), createBookingSchema.parse(req.body)));
});
bookingsRouter.post('/external', requireVerifiedEmail, async (req, res) => {
  res.status(201).json(await bookings.createExternalBooking(actor(req), externalBookingSchema.parse(req.body)));
});
bookingsRouter.get('/mine', async (req, res) => {
  res.json(await bookings.myBookings(actor(req), myBookingsSchema.parse(req.query)));
});
bookingsRouter.get('/:bookingId', async (req, res) => {
  const { bookingId } = bookingIdParams.parse(req.params);
  res.json(await bookings.getBooking(actor(req), bookingId));
});
bookingsRouter.post('/:bookingId/cancel', async (req, res) => {
  const { bookingId } = bookingIdParams.parse(req.params);
  res.json(await bookings.cancelBooking(actor(req), bookingId, reasonSchema.parse(req.body ?? {}).reason));
});
// venue staff answer requests
bookingsRouter.post('/:bookingId/confirm', async (req, res) => {
  const { bookingId } = bookingIdParams.parse(req.params);
  res.json(await bookings.confirmBooking(actor(req), bookingId));
});
bookingsRouter.post('/:bookingId/reject', async (req, res) => {
  const { bookingId } = bookingIdParams.parse(req.params);
  res.json(await bookings.rejectBooking(actor(req), bookingId, reasonSchema.parse(req.body ?? {}).reason));
});

// ───────── /api/v1/venues/:venueId/bookings (venue staff inbox) ─────────
export const venueBookingsRouter = Router({ mergeParams: true });
venueBookingsRouter.use(authenticate);
venueBookingsRouter.get('/', async (req, res) => {
  const { venueId } = venueIdParams.parse(req.params);
  res.json(await bookings.venueBookings(actor(req), venueId, venueBookingsSchema.parse(req.query)));
});
