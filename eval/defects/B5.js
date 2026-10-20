async function correct(req, doc) {
  Object.assign(doc, req.body.changes);
  return doc.save();
}
