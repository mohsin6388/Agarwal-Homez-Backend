const express = require('express');
const router = express.Router();

const authenticate = require('../middlewares/auth');
const roleGuard = require('../middlewares/roleGuard');
const validate = require('../middlewares/validate');

const {
  getDashboardSummary,
  getTimeseries,
  getFunnel,
  getLeadSources,
  getPropertyPerformance,
} = require('../controllers/analyticsController');

const { dashboardQuerySchema, rangeQuerySchema } = require('../validators/analyticsValidators');

// Admins, brokers and builders all have a dashboard; scoping happens inside the controller.
router.use(authenticate, roleGuard('admin', 'broker', 'builder'));

router.get('/dashboard', validate(dashboardQuerySchema), getDashboardSummary);
router.get('/timeseries', validate(rangeQuerySchema), getTimeseries);
router.get('/funnel', validate(dashboardQuerySchema), getFunnel);
router.get('/lead-sources', validate(dashboardQuerySchema), getLeadSources);
router.get('/property-performance', validate(dashboardQuerySchema), getPropertyPerformance);

module.exports = router;
