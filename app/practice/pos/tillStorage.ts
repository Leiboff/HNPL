// Shared localStorage key for the till device secret. One constant so
// the register flow (which writes it) and the till shell (which reads
// it) can never drift onto different key names.
export const TILL_DEVICE_SECRET_KEY = 'hnpl_till_device_secret';
