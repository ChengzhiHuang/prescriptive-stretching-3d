import { thighExtraSpecs } from '../thighExtra';
import { hamstringsSpec } from '../hamstrings';

export default [...thighExtraSpecs.slice(0, 3), hamstringsSpec, ...thighExtraSpecs.slice(3)];
