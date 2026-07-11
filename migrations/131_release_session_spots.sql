-- Migration 131: RPC per rilasciare posti corso prenotati atomicamente quando
-- una prenotazione fallisce dopo book_session_atomic (validazione lavoratori,
-- provider mancante, errore Stripe). Prima non esisteva: ogni fallimento post-
-- prenotazione lasciava i posti riservati per sempre, senza nessuna riga di
-- prenotazione a spiegarlo — capacità del corso persa silenziosamente.

CREATE OR REPLACE FUNCTION release_session_spots(
  p_session_id   uuid,
  p_num_workers  integer
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  UPDATE course_sessions
     SET booked_spots = GREATEST(0, booked_spots - p_num_workers)
   WHERE id = p_session_id;
END;
$$;
