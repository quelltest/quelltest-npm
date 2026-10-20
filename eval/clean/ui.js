function Component() {
  const [value, setValue] = useState(null);
  const ref = useRef(null);
  if (process.env.NODE_ENV !== 'test') console.log(value, ref);
  return setValue;
}
