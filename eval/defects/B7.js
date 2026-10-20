async function checkIn(req) {
  if (await Attendance.exists({ user: req.user.id })) return null;
  return Attendance.create({ user: req.user.id });
}
