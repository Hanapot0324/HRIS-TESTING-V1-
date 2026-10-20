const db = require("../db");
const express = require("express");
const router = express.Router();
// Record ownership (S3): staff may only read/change their own PDS rows.
const { requireAdmin, requireSelfOrAdmin } = require('../middleware/auth');
const {
  isAdminRequest,
  ownRowsOnly,
  requireBodyOwner,
  requireRowOwner,
} = require('../utils/accessScope');

/** Staff may not change their own employee number through a profile save. */
const lockEmployeeNumberToPath = (req, res, next) => {
  if (!isAdminRequest(req)) {
    req.body = { ...(req.body || {}), agencyEmployeeNum: req.params.employeeNumber };
  }
  next();
};
const socketService = require("../socket/socketService");
const authenticateToken = require("./authMiddleware");
const {
  fetchDashboardRow,
  logDashboardCreate,
  logDashboardUpdate,
  logDashboardDelete,
} = require("./dashboardAuditHelper");

router.use(authenticateToken);







router.get('/person_table', ownRowsOnly('agencyEmployeeNum'), (req, res) => {
  const query = 'SELECT * FROM person_table';
  db.query(query, (err, result) => {
    if (err) {
      console.error('Database error:', err);
      return res.status(500).send('Internal Server Error');
    }
    res.status(200).send(result);
  });
});

// GET person by employee number
router.get('/person_table/:employeeNumber', requireSelfOrAdmin('employeeNumber'), (req, res) => {
  const { employeeNumber } = req.params;
  const query = 'SELECT * FROM person_table WHERE agencyEmployeeNum = ?';
  
  db.query(query, [employeeNumber], (err, result) => {
    if (err) {
      console.error('Database error:', err);
      return res.status(500).send('Internal Server Error');
    }
    
    if (result.length === 0) {
      return res.status(404).json({ error: 'Employee not found' });
    }
    
    res.status(200).json(result[0]);
  });
});




router.post('/person_table', requireBodyOwner('agencyEmployeeNum'), (req, res) => {
  const {
    firstName, middleName, lastName, nameExtension, birthDate, placeOfBirth, sex, civilStatus, citizenship, heightCm, weightKg, bloodType,
    gsisNum, pagibigNum, philhealthNum, sssNum, tinNum, agencyEmployeeNum,
    permanent_houseBlockLotNum, permanent_streetName, permanent_subdivisionOrVillage, permanent_barangay, permanent_cityOrMunicipality,
    permanent_provinceName, permanent_zipcode, residential_houseBlockLotNum, residential_streetName, residential_subdivisionOrVillage, residential_barangayName,
    residential_cityOrMunicipality, residential_provinceName, residential_zipcode, telephone, mobileNum, emailAddress,
    spouseFirstName, spouseMiddleName, spouseLastName, spouseNameExtension,
    spouseOccupation, spouseEmployerBusinessName, spouseBusinessAddress, spouseTelephone,
    fatherFirstName, fatherMiddleName, fatherLastName, fatherNameExtension,
    motherMaidenFirstName, motherMaidenMiddleName, motherMaidenLastName,
    elementaryNameOfSchool, elementaryDegree, elementaryPeriodFrom, elementaryPeriodTo,
    elementaryHighestAttained, elementaryYearGraduated, elementaryScholarshipAcademicHonorsReceived,
    secondaryNameOfSchool, secondaryDegree, secondaryPeriodFrom, secondaryPeriodTo,
    secondaryHighestAttained, secondaryYearGraduated, secondaryScholarshipAcademicHonorsReceived
  } = req.body;




  const query = 'INSERT INTO person_table (firstName, middleName, lastName, nameExtension, birthDate, placeOfBirth, sex, civilStatus, citizenship, heightCm, weightKg, bloodType, gsisNum, pagibigNum, philhealthNum, sssNum, tinNum, agencyEmployeeNum, permanent_houseBlockLotNum, permanent_streetName, permanent_subdivisionOrVillage, permanent_barangay, permanent_cityOrMunicipality, permanent_provinceName, permanent_zipcode, residential_houseBlockLotNum, residential_streetName, residential_subdivisionOrVillage, residential_barangayName, residential_cityOrMunicipality, residential_provinceName, residential_zipcode, telephone, mobileNum, emailAddress, spouseFirstName, spouseMiddleName, spouseLastName, spouseNameExtension, spouseOccupation, spouseEmployerBusinessName, spouseBusinessAddress, spouseTelephone, fatherFirstName, fatherMiddleName, fatherLastName, fatherNameExtension, motherMaidenFirstName, motherMaidenMiddleName, motherMaidenLastName, elementaryNameOfSchool, elementaryDegree, elementaryPeriodFrom, elementaryPeriodTo, elementaryHighestAttained, elementaryYearGraduated, elementaryScholarshipAcademicHonorsReceived, secondaryNameOfSchool, secondaryDegree, secondaryPeriodFrom, secondaryPeriodTo, secondaryHighestAttained, secondaryYearGraduated, secondaryScholarshipAcademicHonorsReceived) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)';




  db.query(query, [firstName, middleName, lastName, nameExtension, birthDate, placeOfBirth, sex, civilStatus, citizenship, heightCm, weightKg, bloodType, gsisNum, pagibigNum, philhealthNum, sssNum, tinNum, agencyEmployeeNum, permanent_houseBlockLotNum, permanent_streetName, permanent_subdivisionOrVillage, permanent_barangay, permanent_cityOrMunicipality, permanent_provinceName, permanent_zipcode, residential_houseBlockLotNum, residential_streetName, residential_subdivisionOrVillage, residential_barangayName, residential_cityOrMunicipality, residential_provinceName, residential_zipcode, telephone, mobileNum, emailAddress, spouseFirstName, spouseMiddleName, spouseLastName, spouseNameExtension, spouseOccupation, spouseEmployerBusinessName, spouseBusinessAddress, spouseTelephone, fatherFirstName, fatherMiddleName, fatherLastName, fatherNameExtension, motherMaidenFirstName, motherMaidenMiddleName, motherMaidenLastName, elementaryNameOfSchool, elementaryDegree, elementaryPeriodFrom, elementaryPeriodTo, elementaryHighestAttained, elementaryYearGraduated, elementaryScholarshipAcademicHonorsReceived, secondaryNameOfSchool, secondaryDegree, secondaryPeriodFrom, secondaryPeriodTo, secondaryHighestAttained, secondaryYearGraduated, secondaryScholarshipAcademicHonorsReceived], (err, result) => {
    if (err) {
      console.error('Database error:', err);
      return res.status(500).send('Internal Server Error');
    }

    // Socket.IO (Option A): notify others to refresh
    socketService.notifyPersonalInfoChanged('created', {
      id: result.insertId,
      employeeNumber: agencyEmployeeNum,
    });

    logDashboardCreate(req, 'person_table', result.insertId, req.body);

    res.status(201).send({ message: 'Person record created', id: result.insertId });
  });
});




router.put('/person_table/:id', requireRowOwner('person_table', 'agencyEmployeeNum'), (req, res) => {
  const { id } = req.params;
  const {
    firstName, middleName, lastName, nameExtension, birthDate, placeOfBirth, sex, civilStatus, citizenship, heightCm, weightKg, bloodType,
    gsisNum, pagibigNum, philhealthNum, sssNum, tinNum, agencyEmployeeNum,
    permanent_houseBlockLotNum, permanent_streetName, permanent_subdivisionOrVillage, permanent_barangay, permanent_cityOrMunicipality,
    permanent_provinceName, permanent_zipcode, residential_houseBlockLotNum, residential_streetName, residential_subdivisionOrVillage, residential_barangayName,
    residential_cityOrMunicipality, residential_provinceName, residential_zipcode, telephone, mobileNum, emailAddress,
    spouseFirstName, spouseMiddleName, spouseLastName, spouseNameExtension,
    spouseOccupation, spouseEmployerBusinessName, spouseBusinessAddress, spouseTelephone,
    fatherFirstName, fatherMiddleName, fatherLastName, fatherNameExtension,
    motherMaidenFirstName, motherMaidenMiddleName, motherMaidenLastName,
    elementaryNameOfSchool, elementaryDegree, elementaryPeriodFrom, elementaryPeriodTo,
    elementaryHighestAttained, elementaryYearGraduated, elementaryScholarshipAcademicHonorsReceived,
    secondaryNameOfSchool, secondaryDegree, secondaryPeriodFrom, secondaryPeriodTo,
    secondaryHighestAttained, secondaryYearGraduated, secondaryScholarshipAcademicHonorsReceived
  } = req.body;




  const query = 'UPDATE person_table SET firstName = ?, middleName = ?, lastName = ?, nameExtension = ?, birthDate = ?, placeOfBirth = ?, sex = ?, civilStatus = ?, citizenship = ?, heightCm = ?, weightKg = ?, bloodType = ?, gsisNum = ?, pagibigNum = ?, philhealthNum = ?, sssNum = ?, tinNum = ?, agencyEmployeeNum = ?, permanent_houseBlockLotNum = ?, permanent_streetName = ?, permanent_subdivisionOrVillage = ?, permanent_barangay = ?, permanent_cityOrMunicipality = ?, permanent_provinceName = ?, permanent_zipcode = ?, residential_houseBlockLotNum = ?, residential_streetName = ?, residential_subdivisionOrVillage = ?, residential_barangayName = ?, residential_cityOrMunicipality = ?, residential_provinceName = ?, residential_zipcode = ?, telephone = ?, mobileNum = ?, emailAddress = ?, spouseFirstName = ?, spouseMiddleName = ?, spouseLastName = ?, spouseNameExtension = ?, spouseOccupation = ?, spouseEmployerBusinessName = ?, spouseBusinessAddress = ?, spouseTelephone = ?, fatherFirstName = ?, fatherMiddleName = ?, fatherLastName = ?, fatherNameExtension = ?, motherMaidenFirstName = ?, motherMaidenMiddleName = ?, motherMaidenLastName = ?, elementaryNameOfSchool = ?, elementaryDegree = ?, elementaryPeriodFrom = ?, elementaryPeriodTo = ?, elementaryHighestAttained = ?, elementaryYearGraduated = ?, elementaryScholarshipAcademicHonorsReceived = ?, secondaryNameOfSchool = ?, secondaryDegree = ?, secondaryPeriodFrom = ?, secondaryPeriodTo = ?, secondaryHighestAttained = ?, secondaryYearGraduated = ?, secondaryScholarshipAcademicHonorsReceived = ? WHERE id = ?';




  fetchDashboardRow('person_table', id, (fetchErr, oldRow) => {
    if (fetchErr) {
      console.error('Database error:', fetchErr);
      return res.status(500).send('Internal Server Error');
    }
    if (!oldRow) return res.status(404).send({ message: 'Person record not found' });

    db.query(query, [firstName, middleName, lastName, nameExtension, birthDate, placeOfBirth, sex, civilStatus, citizenship, heightCm, weightKg, bloodType, gsisNum, pagibigNum, philhealthNum, sssNum, tinNum, agencyEmployeeNum, permanent_houseBlockLotNum, permanent_streetName, permanent_subdivisionOrVillage, permanent_barangay, permanent_cityOrMunicipality, permanent_provinceName, permanent_zipcode, residential_houseBlockLotNum, residential_streetName, residential_subdivisionOrVillage, residential_barangayName, residential_cityOrMunicipality, residential_provinceName, residential_zipcode, telephone, mobileNum, emailAddress, spouseFirstName, spouseMiddleName, spouseLastName, spouseNameExtension, spouseOccupation, spouseEmployerBusinessName, spouseBusinessAddress, spouseTelephone, fatherFirstName, fatherMiddleName, fatherLastName, fatherNameExtension, motherMaidenFirstName, motherMaidenMiddleName, motherMaidenLastName, elementaryNameOfSchool, elementaryDegree, elementaryPeriodFrom, elementaryPeriodTo, elementaryHighestAttained, elementaryYearGraduated, elementaryScholarshipAcademicHonorsReceived, secondaryNameOfSchool, secondaryDegree, secondaryPeriodFrom, secondaryPeriodTo, secondaryHighestAttained, secondaryYearGraduated, secondaryScholarshipAcademicHonorsReceived, id], (err) => {
      if (err) {
        console.error('Database error:', err);
        return res.status(500).send('Internal Server Error');
      }

      logDashboardUpdate(req, 'person_table', id, oldRow, req.body);

      socketService.notifyPersonalInfoChanged('updated', {
        id: Number(id),
        employeeNumber: agencyEmployeeNum,
      });

      res.status(200).send({ message: 'Person record updated' });
    });
  });
});

// Update only name fields by employee number
router.put('/person/:employeeNumber', requireSelfOrAdmin('employeeNumber'), (req, res) => {
  const { employeeNumber } = req.params;
  const { firstName, middleName, lastName, nameExtension } = req.body;

  if (!firstName || !lastName) {
    return res.status(400).json({ error: 'First name and last name are required' });
  }

  const query = `UPDATE person_table SET 
    firstName = ?, 
    middleName = ?, 
    lastName = ?, 
    nameExtension = ?
    WHERE agencyEmployeeNum = ?`;

  db.query(query, [
    firstName, 
    middleName || null, 
    lastName, 
    nameExtension || null,
    employeeNumber
  ], (err, result) => {
    if (err) {
      console.error('Database error:', err);
      return res.status(500).json({ error: 'Internal Server Error', details: err.message });
    }
    
    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'Employee not found' });
    }

    // Socket.IO (Option A): notify others to refresh
    socketService.notifyPersonalInfoChanged('updated', {
      employeeNumber: employeeNumber,
    });

    
    res.status(200).json({ 
      message: 'Name updated successfully',
      employeeNumber: employeeNumber
    });
  });
});

// Add this route for updating by employee number
router.put('/person_table/by-employee/:employeeNumber', requireSelfOrAdmin('employeeNumber'), lockEmployeeNumberToPath, (req, res) => {
  const { employeeNumber } = req.params;
  const {
    firstName, middleName, lastName, nameExtension, birthDate, placeOfBirth, sex, civilStatus, citizenship, heightCm, weightKg, bloodType,
    gsisNum, pagibigNum, philhealthNum, sssNum, tinNum, agencyEmployeeNum,
    permanent_houseBlockLotNum, permanent_streetName, permanent_subdivisionOrVillage, permanent_barangay, permanent_barangayName, permanent_cityOrMunicipality,
    permanent_provinceName, permanent_zipcode, residential_houseBlockLotNum, residential_streetName, residential_subdivisionOrVillage, residential_barangayName,
    residential_cityOrMunicipality, residential_provinceName, residential_zipcode, telephone, mobileNum, emailAddress,
    spouseFirstName, spouseMiddleName, spouseLastName, spouseNameExtension,
    spouseOccupation, spouseEmployerBusinessName, spouseBusinessAddress, spouseTelephone,
    fatherFirstName, fatherMiddleName, fatherLastName, fatherNameExtension,
    motherMaidenFirstName, motherMaidenMiddleName, motherMaidenLastName,
    elementaryNameOfSchool, elementaryDegree, elementaryPeriodFrom, elementaryPeriodTo,
    elementaryHighestAttained, elementaryYearGraduated, elementaryScholarshipAcademicHonorsReceived,
    secondaryNameOfSchool, secondaryDegree, secondaryPeriodFrom, secondaryPeriodTo,
    secondaryHighestAttained, secondaryYearGraduated, secondaryScholarshipAcademicHonorsReceived
  } = req.body;

  // Backward compat: some clients send `permanent_barangayName`
  const permanentBarangayValue = permanent_barangay ?? permanent_barangayName;

  const query = `UPDATE person_table SET 
    firstName = ?, middleName = ?, lastName = ?, nameExtension = ?, birthDate = ?, placeOfBirth = ?, sex = ?, civilStatus = ?, citizenship = ?, heightCm = ?, weightKg = ?, bloodType = ?, 
    gsisNum = ?, pagibigNum = ?, philhealthNum = ?, sssNum = ?, tinNum = ?, agencyEmployeeNum = ?, 
    permanent_houseBlockLotNum = ?, permanent_streetName = ?, permanent_subdivisionOrVillage = ?, permanent_barangay = ?, permanent_cityOrMunicipality = ?, permanent_provinceName = ?, permanent_zipcode = ?, 
    residential_houseBlockLotNum = ?, residential_streetName = ?, residential_subdivisionOrVillage = ?, residential_barangayName = ?, residential_cityOrMunicipality = ?, residential_provinceName = ?, residential_zipcode = ?, 
    telephone = ?, mobileNum = ?, emailAddress = ?, 
    spouseFirstName = ?, spouseMiddleName = ?, spouseLastName = ?, spouseNameExtension = ?, spouseOccupation = ?, spouseEmployerBusinessName = ?, spouseBusinessAddress = ?, spouseTelephone = ?, 
    fatherFirstName = ?, fatherMiddleName = ?, fatherLastName = ?, fatherNameExtension = ?, motherMaidenFirstName = ?, motherMaidenMiddleName = ?, motherMaidenLastName = ?, 
    elementaryNameOfSchool = ?, elementaryDegree = ?, elementaryPeriodFrom = ?, elementaryPeriodTo = ?, elementaryHighestAttained = ?, elementaryYearGraduated = ?, elementaryScholarshipAcademicHonorsReceived = ?, 
    secondaryNameOfSchool = ?, secondaryDegree = ?, secondaryPeriodFrom = ?, secondaryPeriodTo = ?, secondaryHighestAttained = ?, secondaryYearGraduated = ?, secondaryScholarshipAcademicHonorsReceived = ? 
    WHERE agencyEmployeeNum = ?`;

  db.query(query, [
    firstName, middleName, lastName, nameExtension, birthDate, placeOfBirth, sex, civilStatus, citizenship, heightCm, weightKg, bloodType,
    gsisNum, pagibigNum, philhealthNum, sssNum, tinNum, agencyEmployeeNum,
    permanent_houseBlockLotNum, permanent_streetName, permanent_subdivisionOrVillage, permanentBarangayValue, permanent_cityOrMunicipality, permanent_provinceName, permanent_zipcode,
    residential_houseBlockLotNum, residential_streetName, residential_subdivisionOrVillage, residential_barangayName, residential_cityOrMunicipality, residential_provinceName, residential_zipcode,
    telephone, mobileNum, emailAddress,
    spouseFirstName, spouseMiddleName, spouseLastName, spouseNameExtension, spouseOccupation, spouseEmployerBusinessName, spouseBusinessAddress, spouseTelephone,
    fatherFirstName, fatherMiddleName, fatherLastName, fatherNameExtension, motherMaidenFirstName, motherMaidenMiddleName, motherMaidenLastName,
    elementaryNameOfSchool, elementaryDegree, elementaryPeriodFrom, elementaryPeriodTo, elementaryHighestAttained, elementaryYearGraduated, elementaryScholarshipAcademicHonorsReceived,
    secondaryNameOfSchool, secondaryDegree, secondaryPeriodFrom, secondaryPeriodTo, secondaryHighestAttained, secondaryYearGraduated, secondaryScholarshipAcademicHonorsReceived,
    employeeNumber
  ], (err, result) => {
    if (err) {
      console.error('Database error:', err);
      return res.status(500).json({ error: 'Internal Server Error', details: err.message });
    }
    
    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'Employee not found' });
    }

    // Socket.IO (Option A): notify others to refresh
    socketService.notifyPersonalInfoChanged('updated', {
      employeeNumber: employeeNumber,
    });

    
    res.status(200).json({ message: 'Person record updated successfully' });
  });
});



router.delete('/person_table/:id', requireAdmin, (req, res) => {
  const { id } = req.params;
  const query = 'DELETE FROM person_table WHERE id = ?';
 
  fetchDashboardRow('person_table', id, (fetchErr, oldRow) => {
    if (fetchErr) {
      console.error('Database error:', fetchErr);
      return res.status(500).send('Internal Server Error');
    }
    if (!oldRow) return res.status(404).send({ message: 'Person record not found' });

    db.query(query, [id], (err) => {
      if (err) {
        console.error('Database error:', err);
        return res.status(500).send('Internal Server Error');
      }

      logDashboardDelete(req, 'person_table', id, oldRow);

      socketService.notifyPersonalInfoChanged('deleted', { id: Number(id) });

      res.status(200).send({ message: 'Person record deleted' });
    });
  });
});


router.delete('/remove-profile-picture/:id', requireRowOwner('person_table', 'agencyEmployeeNum'), (req, res) => {
  const { id } = req.params;
  const query = 'UPDATE person_table SET profile_picture = NULL WHERE id = ?';
  
  db.query(query, [id], (err, result) => {
    if (err) {
      console.error(err);
      return res.status(500).send({ message: 'Database error' });
    }

    // Socket.IO (Option A): notify others to refresh
    socketService.notifyPersonalInfoChanged('updated', { id: Number(id) });

    res.status(200).send({ message: 'Profile picture removed' });
  });
});




module.exports = router;









