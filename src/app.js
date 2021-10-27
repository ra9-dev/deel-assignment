const express = require("express");
const moment = require("moment");
const bodyParser = require("body-parser");
const { sequelize } = require("./model");
const { getProfile } = require("./middleware/getProfile");
const { Op } = require("sequelize");
const app = express();
app.use(bodyParser.json());
app.set("sequelize", sequelize);
app.set("models", sequelize.models);

/**
 * @returns contract by id
 */
app.get("/contracts/:id", getProfile, async (req, res) => {
  const { Contract } = req.app.get("models");
  const { id } = req.params;
  const profileFKey =
    req.profile.type == "client" ? "ClientId" : "ContractorId";
  // console.log("fetching from", profileFKey);
  const contract = await Contract.findOne({
    where: {
      id: id,
      [profileFKey]: req.profile.id,
    },
  });
  if (!contract) return res.status(404).end();
  res.json(contract);
});

/**
 * @returns all non-terminated contracts by user id
 */
app.get("/contracts", getProfile, async (req, res) => {
  const { Contract } = req.app.get("models");
  const profileFKey =
    req.profile.type == "client" ? "ClientId" : "ContractorId";
  // console.log("fetching from", profileFKey);
  const contracts = await Contract.findAll({
    where: {
      [profileFKey]: req.profile.id,
      [Op.not]: [
        {
          status: "terminated",
        },
      ],
    },
  });
  if (!contracts || contracts.length == 0) return res.status(404).end();
  res.json(contracts);
});

/**
 * @returns all unpaid jobs for active contracts for a user
 */
app.get("/jobs/unpaid", getProfile, async (req, res) => {
  const { Job, Contract } = req.app.get("models");
  const profileFKey =
    req.profile.type == "client" ? "ClientId" : "ContractorId";
  // console.log("fetching from", profileFKey);
  const jobs = await Job.findAll({
    where: {
      paid: null,
    },
    include: [
      {
        model: Contract,
        // attributes: [],
        where: {
          [profileFKey]: req.profile.id,
          status: "in_progress",
        },
      },
    ],
  });
  if (!jobs || jobs.length == 0) return res.status(404).end();
  res.json(jobs);
});

/**
 * @returns 401 unauthorised if profile isn't client.
 * ! only client can pay
 * ! only unpaid jobs can be paid
 * TODO:    1. check for above checks.. if valid then proceed else 404
 * TODO:    2. check if client has enough money. if yes carry ahead else ask to deposit
 * TODO:    3. transfer money/increment and decrement amount to contractor from client(transactional)
 * TODO:    4. mark job as paid and enter todays date as payment date
 * Pay for a job, a client can only pay
 * if his balance >= the amount to pay.
 * The amount should be moved from the client's balance to the contractor balance.
 */
app.post("/jobs/:jobId/pay", getProfile, async (req, res) => {
  if (req.profile.type != "client") {
    return res
      .status(401)
      .json({ error: "Only Clients are allowed to authorise payment." })
      .end();
  }
  const { jobId } = req.params;
  const { Job, Contract, Profile } = req.app.get("models");
  const job = await Job.findOne({
    attributes: ["id", "price", "paid"],
    where: {
      id: jobId,
      paid: null,
    },
    include: [
      {
        model: Contract,
        attributes: ["id", "ContractorId", "ClientId"],
        where: {
          ClientId: req.profile.id,
        },
      },
    ],
  });
  // no unpaid job receieved
  if (!job) return res.status(404).end();
  // client balance less than job price
  if (req.profile.balance < job.price) {
    result = {
      jobId: jobId,
      jobPrice: job.price,
      contractId: job.Contract.id,
      contractorId: job.Contract.ContractorId,
      clientId: req.profile.id,
      clientBalance: req.profile.balance,
      error: "Insufficient Funds",
    };
    res.status(400).json(result);
  } else {
    try {
      const queryResult = await sequelize.transaction(async (t) => {
        const clientUpdate = await Profile.decrement("balance", {
          by: job.price,
          where: { id: req.profile.id },
          transaction: t,
        });
        // console.log("clientUpdate", clientUpdate);

        const contractorUpdate = await Profile.increment("balance", {
          by: job.price,
          where: { id: job.Contract.ContractorId },
          transaction: t,
        });
        // console.log("contractorUpdate", contractorUpdate);
      });
      // console.log("queryResult", queryResult);
      const jobUpdate = await Job.update(
        { paid: "1", paymentDate: sequelize.literal("CURRENT_TIMESTAMP") },
        {
          where: { id: jobId },
        }
      );
      // console.log("jobUpdate", jobUpdate);
      result = {
        contractId: job.Contract.id,
        contractorId: job.Contract.ContractorId,
        clientId: req.profile.id,
        message: "Paid Successfully.",
      };
      res.json(result);
    } catch (error) {
      console.log("error", error);
      result = {
        jobId: jobId,
        jobPrice: job.price,
        clientBalance: req.profile.balance,
        contractId: job.Contract.id,
        contractorId: job.Contract.ContractorId,
        clientId: req.profile.id,
        error: "Database error",
        debug: error,
      };
      res.status(500).json(result);
    }
  }
});

/**
 * @returns 401 unauthorised if profile isn't client.
 * @expects `amount` in request body.
 * ! only client can deposit
 * TODO:    1. get all unpaid jobs under this client
 * TODO:    2. check if amount is greater than 25% of jobs to be paid
 * TODO:    3. increment amount in client balance
 * Deposits money into the the the balance of a client
 */
app.post("/balances/deposit", getProfile, async (req, res) => {
  const reqBody = req.body;
  const { Job, Contract, Profile } = req.app.get("models");
  if (req.profile.type != "client") {
    return res
      .status(401)
      .json({ error: "Only Clients are allowed to authorise deposits." })
      .end();
  } else if (!reqBody.hasOwnProperty("amount")) {
    return res
      .status(401)
      .json({ error: "Deposit amount not mentioned." })
      .end();
  } else {
    // we have a client.. depositing some amount.. lets check its jobs
    let result = {
      clientId: req.profile.id,
      depositAmount: reqBody.amount,
      currentBalance: req.profile.balance,
      oldBalance: req.profile.balance,
    };
    const jobs = await Job.findAll({
      attributes: [
        [sequelize.fn("sum", sequelize.col("price")), "totalUnpaidBalance"],
      ],
      raw: true,
      where: {
        paid: null,
      },
      include: [
        {
          model: Contract,
          attributes: [],
          where: {
            ClientId: req.profile.id,
          },
        },
      ],
    });
    if (
      !jobs ||
      jobs.length == 0 ||
      !jobs[0].totalUnpaidBalance ||
      jobs[0].totalUnpaidBalance == 0
    ) {
      result["error"] = "No unpaid jobs.";
      return res.status(400).json(result).end();
    } else {
      result["totalUnpaidBalance"] = jobs[0].totalUnpaidBalance;
      if (reqBody.amount > jobs[0].totalUnpaidBalance / 4) {
        result["error"] = "Can't deposit more than 25% of your unpaid balance.";
        return res.status(400).json(result).end();
      } else {
        try {
          await Profile.increment("balance", {
            by: reqBody.amount,
            where: { id: req.profile.id },
          });
          result["currentBalance"] += reqBody.amount;
          result["message"] = "Amount deposited!";
          res.json(result);
        } catch (error) {
          res.status(500).json(result);
        }
      }
    }
  }
});

/**
 * @returns the clients that
 * paid the most for jobs in the query time period
 * that worked in the query time range.
 */
app.get("/admin/best-profession", getProfile, async (req, res) => {
  const { Job, Contract, Profile } = req.app.get("models");
  let startDate = req.query.start;
  let endDate = req.query.end;
  if (
    !startDate ||
    !endDate ||
    !moment(startDate, "MM-DD-YYYY", true).isValid() ||
    !moment(endDate, "MM-DD-YYYY", true).isValid()
  ) {
    result = { error: "Invalid Dates. Enter date in MM-DD-YYYY format." };
    res.status(400).json(result).end();
  } else {
    startDateMoment = moment(startDate, "MM-DD-YYYY");
    endDateMoment = moment(endDate, "MM-DD-YYYY");
    console.log("startdata", startDateMoment);
    console.log("enddata", endDateMoment);
    result = {
      start: startDate,
      end: endDate,
    };
    if (startDateMoment.isSameOrAfter(endDateMoment)) {
      result["error"] =
        "Invalid Date Combination. Start Date should be lesser than end date.";
      res.status(400).json(result).end();
    } else {
      try {
        const jobs = await Job.findAll({
          group: ["Contract.Contractor.profession"],
          attributes: [
            "Contract.Contractor.profession",
            [sequelize.fn("sum", sequelize.col("price")), "PaidAmount"],
          ],
          raw: true,
          where: {
            paid: true,
            createdAt: {
              [Op.gte]: startDateMoment.toDate(),
              [Op.lt]: endDateMoment.toDate(),
            },
          },
          include: [
            {
              model: Contract,
              attributes: [],
              include: [
                {
                  model: Profile,
                  attributes: [],
                  as: "Contractor",
                },
              ],
            },
          ],
        });
        const bestProfession = jobs.reduce((prev, current) =>
          prev.PaidAmount > current.PaidAmount ? prev : current
        );
        result["bestProfession"] = bestProfession;
      } catch (error) {
        result["error"] = "No Jobs found under this date range";
      }
      res.json(result);
    }
  }
});

/**
 * @returns the profession that
 * paid the most for jobs in the query time period
 */
app.get("/admin/best-clients", getProfile, async (req, res) => {
  const { Job, Contract, Profile } = req.app.get("models");
  let startDate = req.query.start;
  let endDate = req.query.end;
  let limit = req.query.limit;
  limit = limit ? limit : 2;
  if (
    !startDate ||
    !endDate ||
    !moment(startDate, "MM-DD-YYYY", true).isValid() ||
    !moment(endDate, "MM-DD-YYYY", true).isValid()
  ) {
    result = { error: "Invalid Dates. Enter date in MM-DD-YYYY format." };
    res.status(400).json(result).end();
  } else {
    startDateMoment = moment(startDate, "MM-DD-YYYY");
    endDateMoment = moment(endDate, "MM-DD-YYYY");
    console.log("startdata", startDateMoment);
    console.log("enddata", endDateMoment);
    result = {
      start: startDate,
      end: endDate,
    };
    if (startDateMoment.isSameOrAfter(endDateMoment)) {
      result["error"] =
        "Invalid Date Combination. Start Date should be lesser than end date.";
      res.status(400).json(result).end();
    } else {
      try {
        const topPayingClients = await Job.findAll({
          group: ["Contract.Client.id"],
          attributes: [
            "Contract.Client.id",
            "Contract.Client.firstName",
            "Contract.Client.lastName",
            "Contract.Client.profession",
            [sequelize.fn("sum", sequelize.col("price")), "PaidAmount"],
          ],
          raw: true,
          where: {
            paid: true,
            createdAt: {
              [Op.gte]: startDateMoment.toDate(),
              [Op.lt]: endDateMoment.toDate(),
            },
          },
          include: [
            {
              model: Contract,
              attributes: [],
              include: [
                {
                  model: Profile,
                  attributes: [],
                  as: "Client",
                },
              ],
            },
          ],
          order: sequelize.literal("PaidAmount DESC"),
          limit: limit,
        });
        result["topPayingClients"] = topPayingClients;
      } catch (error) {
        result["error"] = "No Jobs found under this date range";
      }
      res.json(result);
    }
  }
});

module.exports = app;
