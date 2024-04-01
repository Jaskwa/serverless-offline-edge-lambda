import bodyParser from 'body-parser';
import { NextFunction } from 'express';

export function cloudfrontPost() {
	return (req: any, res: any, next: NextFunction) => {
		if (req.method === 'POST') {
			bodyParser.raw({ type: '*/*' })(req, res, (err) => {
				if (err) {
					next(err);
				}
				console.log('*** cloudfrontPost middleware ***');
				console.log('body:');
				console.log(JSON.stringify(req.body, null, 2));
				req.body = { data: JSON.stringify(req.body) === '{}' ? '' : req.body };

				next();
			});
		} else {
			next();
		}
	};
}
