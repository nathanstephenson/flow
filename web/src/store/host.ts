import { connect } from "../../../src/client/connection.ts";
import { beginReauthentication } from "../authentication.ts";

export const host = connect({ url: "", authenticationRequired: beginReauthentication });
